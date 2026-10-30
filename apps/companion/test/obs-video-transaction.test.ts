import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsVideoTransaction } from '../src/obs/video-transaction.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const original = {
  baseWidth: 2560,
  baseHeight: 1440,
  outputWidth: 1280,
  outputHeight: 720,
  fpsNumerator: 30,
  fpsDenominator: 1,
};
function fixture() {
  let profile = 'Personal';
  let settings = { ...original };
  let outputs: Record<string, unknown>[] = [];
  let failAfterWrite = false;
  const calls: { type: string; data: Record<string, unknown> | undefined }[] = [];
  const obs: ObsRpc = {
    call: async (type, data) => {
      calls.push({ type, data });
      if (type === 'GetProfileList') return { currentProfileName: profile };
      if (type === 'GetVideoSettings') return { ...settings };
      if (type === 'GetOutputList') return { outputs };
      if (type === 'SetVideoSettings') {
        settings = { ...settings, ...data };
        if (failAfterWrite) {
          failAfterWrite = false;
          throw new Error('reply lost');
        }
        return {};
      }
      throw new Error(`Unexpected request ${type}`);
    },
  };
  return {
    obs,
    calls,
    get settings() {
      return settings;
    },
    set profile(value: string) {
      profile = value;
    },
    set settings(value: typeof original) {
      settings = value;
    },
    set outputs(value: Record<string, unknown>[]) {
      outputs = value;
    },
    set failAfterWrite(value: boolean) {
      failAfterWrite = value;
    },
  };
}
async function usingTest(
  run: (tx: ObsVideoTransaction, f: ReturnType<typeof fixture>) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-obs-video-'));
  try {
    await run(new ObsVideoTransaction(join(dir, 'journal.json')), fixture());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const endpoint = 'ws://127.0.0.1:4455';

test('preflight rejects an active video output without touching OBS or creating a journal', async () =>
  usingTest(async (tx, f) => {
    f.outputs = [
      { outputName: 'Virtual camera', outputActive: true, outputFlags: { OBS_OUTPUT_VIDEO: true } },
    ];
    await assert.rejects(tx.preflight(f.obs, endpoint), /Virtual camera/);
    assert.equal(await tx.pending(), false);
    assert.ok(f.calls.every(({ type }) => type.startsWith('Get')));
  }));

test('already suitable video does not interrupt active output', async () =>
  usingTest(async (tx, f) => {
    f.settings = {
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 60,
      fpsDenominator: 1,
    };
    f.outputs = [
      { outputName: 'Stream', outputActive: true, outputFlags: { OBS_OUTPUT_VIDEO: true } },
    ];
    await tx.preflight(f.obs, endpoint);
    assert.equal(await tx.prepare(f.obs, endpoint, () => true), null);
    assert.ok(f.calls.every(({ type }) => type.startsWith('Get')));
  }));

test('restores only unchanged pairs in the original profile and never stops output', async () =>
  usingTest(async (tx, f) => {
    const id = await tx.prepare(f.obs, endpoint, () => true);
    assert.ok(id);
    f.settings = { ...f.settings, outputWidth: 1600, outputHeight: 900 };
    f.profile = 'Another';
    await assert.rejects(tx.restore(f.obs, endpoint, id), /原配置档/);
    assert.equal(await tx.pending(), true);
    f.profile = 'Personal';
    f.outputs = [
      { outputName: 'Replay buffer', outputActive: true, outputFlags: { OBS_OUTPUT_VIDEO: true } },
    ];
    await assert.rejects(tx.restore(f.obs, endpoint, id), /Replay buffer/);
    assert.equal(await tx.pending(), true);
    f.outputs = [];
    await tx.restore(f.obs, endpoint, id);
    assert.deepEqual(f.settings, { ...original, outputWidth: 1600, outputHeight: 900 });
    assert.equal(await tx.pending(), false);
    assert.ok(f.calls.every(({ type }) => !type.startsWith('Stop')));
  }));

test('uncertain write is read back and rolled back, never replayed', async () =>
  usingTest(async (tx, f) => {
    f.failAfterWrite = true;
    await assert.rejects(
      tx.prepare(f.obs, endpoint, () => true),
      /reply lost/,
    );
    assert.deepEqual(f.settings, original);
    assert.equal(await tx.pending(), false);
    assert.equal(f.calls.filter(({ type }) => type === 'SetVideoSettings').length, 2);
  }));

test('stale transaction id cannot restore a newer session', async () =>
  usingTest(async (tx, f) => {
    const id = await tx.prepare(f.obs, endpoint, () => true);
    await tx.restore(f.obs, endpoint, '00000000-0000-4000-8000-000000000000');
    assert.equal(await tx.pending(), true);
    assert.equal(f.settings.baseWidth, 1920);
    await tx.restore(f.obs, endpoint, id!);
    assert.deepEqual(f.settings, original);
  }));

test('a new service instance discovers and restores the persisted transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-video-restart-'));
  try {
    const path = join(dir, 'journal.json');
    const f = fixture();
    await new ObsVideoTransaction(path).prepare(f.obs, endpoint, () => true);
    const restarted = new ObsVideoTransaction(path);
    assert.equal(await restarted.pending(), true);
    await restarted.restore(f.obs, endpoint);
    assert.deepEqual(f.settings, original);
    assert.equal(await restarted.pending(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
