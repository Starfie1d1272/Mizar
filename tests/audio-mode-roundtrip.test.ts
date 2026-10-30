import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioModeRig } from './audio-mode-test-rig.js';
import { AudioMigration } from '../apps/companion/src/obs/audio-migration.js';

const rigs: Awaited<ReturnType<typeof audioModeRig>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});
async function setup(initialMonitor?: string) {
  const rig = await audioModeRig(initialMonitor);
  rigs.push(rig);
  return rig;
}
async function change(
  rig: Awaited<ReturnType<typeof audioModeRig>>,
  mode: 'desktop' | 'independent',
) {
  const read = await rig.request('GET', '/local/v1/obs/audio-routing');
  expect(read.statusCode).toBe(200);
  return rig.request('POST', '/operator/obs/audio-mode', { mode, revision: read.json().revision });
}

it.each(['OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', 'OBS_MONITORING_TYPE_MONITOR_ONLY'])(
  'switches initial desktop through the real API without overlap and restores %s',
  async (initialMonitor) => {
    const rig = await setup(initialMonitor);
    const desktop = await change(rig, 'desktop');
    expect(desktop.statusCode, desktop.body).toBe(200);
    expect(rig.monitor()).toBe('OBS_MONITORING_TYPE_NONE');
    const backup = JSON.parse(await readFile(join(rig.dir, 'journal.migration-mode'), 'utf8')) as {
      fields: { kind?: string }[];
    };
    expect(backup.fields).toHaveLength(1);
    expect(backup.fields[0]?.kind).toBe('monitor');
    rig.timeline.length = 0;
    const independent = await change(rig, 'independent');
    expect(independent.statusCode, independent.body).toBe(200);
    expect(independent.json().waiting).toBe(false);
    expect(rig.violations).toEqual([]);
    const firstNewPath = rig.timeline.findIndex(
      (entry) => entry === 'game:true' || entry === 'ts:true',
    );
    expect(
      rig.timeline.slice(0, firstNewPath).filter((entry) => entry === 'desktop:false'),
    ).toHaveLength(rig.scenes.size);
    expect(rig.timeline.indexOf(`monitor:${initialMonitor}`)).toBeGreaterThan(
      rig.timeline.lastIndexOf('desktop:false'),
    );
    for (const items of rig.scenes.values()) {
      expect(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled).toBe(false);
      expect(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled).toBe(true);
      expect(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled).toBe(true);
      expect(items.find((item) => item.sourceUuid === 'mic')?.sceneItemEnabled).toBe(true);
    }
    expect(rig.monitor()).toBe(initialMonitor);
    expect((await rig.routing.modeRecoveryState()).desktop).toBeNull();
    expect((await rig.routing.modeRecoveryState()).transition).toBeNull();
  },
);

it('closes independent paths before restoring desktop after an uncertain write', async () => {
  const rig = await setup();
  expect((await change(rig, 'desktop')).statusCode).toBe(200);
  rig.failIndependent();
  expect((await change(rig, 'independent')).statusCode).toBe(409);
  expect(rig.violations).toEqual([]);
  await rig.adapter.recoverAudioMode(rig.music as never);
  expect(rig.violations).toEqual([]);
  for (const items of rig.scenes.values()) {
    expect(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled).toBe(true);
    expect(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled).toBe(false);
    expect(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled).toBe(false);
  }
  expect(rig.monitor()).toBe('OBS_MONITORING_TYPE_NONE');
  expect((await rig.routing.modeRecoveryState()).desktop?.inputUuid).toBe('desktop');
});

it('recovers the old incomplete backup if target validation finds the desktop still active', async () => {
  const rig = await setup();
  expect((await change(rig, 'desktop')).statusCode).toBe(200);
  const restore = AudioMigration.prototype.restoreCompleted;
  vi.spyOn(AudioMigration.prototype, 'restoreCompleted').mockImplementation(function (...args) {
    args[8] = [];
    return restore.apply(this, args);
  });
  expect((await change(rig, 'independent')).statusCode).toBe(409);
  for (const items of rig.scenes.values()) {
    expect(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled).toBe(true);
    expect(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled).toBe(false);
    expect(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled).toBe(false);
  }
  expect(rig.monitor()).toBe('OBS_MONITORING_TYPE_NONE');
  await rig.adapter.recoverAudioMode(rig.music as never);
  expect((await rig.routing.modeRecoveryState()).transition).toBeNull();
});

it('does not restore an unselected video audio path alongside independent game audio', async () => {
  const rig = await setup();
  rig.setVideoCapture(true);
  expect((await change(rig, 'desktop')).statusCode).toBe(200);
  expect((await change(rig, 'independent')).statusCode).toBe(409);
  expect(rig.violations).toEqual([]);
  for (const items of rig.scenes.values()) {
    expect(items.find((item) => item.sourceUuid === 'desktop')?.sceneItemEnabled).toBe(true);
    expect(items.find((item) => item.sourceUuid === 'game')?.sceneItemEnabled).toBe(false);
    expect(items.find((item) => item.sourceUuid === 'ts')?.sceneItemEnabled).toBe(false);
  }
  expect(rig.monitor()).toBe('OBS_MONITORING_TYPE_NONE');
  await rig.adapter.recoverAudioMode(rig.music as never);
  expect((await rig.routing.modeRecoveryState()).transition).toBeNull();
});
