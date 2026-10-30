import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { OBS_CAPTURE_INPUT, obsDesiredScenes } from '../src/obs/desired-state.js';
import { isModernTeamspeak, isTeamspeak, RemoteCommentary } from '../src/obs/remote-commentary.js';
import type { MigrationObserver } from '../src/obs/audio-migration.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const base = 'http://127.0.0.1:3000';
const scenes = obsDesiredScenes(base);

async function fixture(
  options: {
    active?: boolean;
    duplicate?: boolean;
    changed?: boolean;
    monitor?: string;
    monitorDevice?: string;
    captureDevice?: string;
    monitorFailure?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-ts-compat-'));
  dirs.push(dir);
  const routing = new ObsAudioRouting(join(dir, 'routing.json'));
  const owner = new RemoteCommentary(join(dir, 'commentary.json'));
  const adapter = new ObsAdapter(
    new ObsConfigStore(join(dir, 'obs.json')),
    base,
    undefined,
    routing,
    {
      owner,
      journal: join(dir, 'journal'),
    },
  );
  let listener: Parameters<MigrationObserver['subscribe']>[0] | undefined;
  const observer: MigrationObserver = {
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };
  const inputs = [
    ...scenes.map((scene) => ({
      inputName: scene.browserInput,
      inputKind: 'browser_source',
      inputUuid: scene.browserInput,
    })),
    { inputName: OBS_CAPTURE_INPUT, inputKind: 'game_capture', inputUuid: 'video' },
    { inputName: '桌面声音', inputKind: 'wasapi_output_capture', inputUuid: 'desktop' },
    { inputName: '麦克风', inputKind: 'wasapi_input_capture', inputUuid: 'mic' },
    { inputName: '其他解说', inputKind: 'wasapi_process_output_capture', inputUuid: 'ts' },
    { inputName: 'CS2 process', inputKind: 'wasapi_process_output_capture', inputUuid: 'game' },
  ];
  const calls: string[] = [];
  const obs: ObsRpc = {
    async call(type, data = {}) {
      calls.push(type);
      if (type === 'GetVersion')
        return {
          availableRequests: [
            'GetInputList',
            'GetInputSettings',
            'GetSceneCollectionList',
            'GetSpecialInputs',
            'GetSceneList',
            'GetSceneItemList',
            'GetGroupSceneItemList',
          ],
        };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetSpecialInputs') return {};
      if (type === 'GetInputList') return { inputs };
      if (type === 'GetSceneList')
        return { scenes: scenes.map((scene) => ({ sceneName: scene.sceneName })) };
      if (type === 'GetInputSettings') {
        if (data.inputUuid === 'ts')
          return { inputSettings: { window: 'TeamSpeak:Qt:teamspeak.exe' } };
        if (data.inputUuid === 'game') return { inputSettings: { window: 'CS2:SDL:cs2.exe' } };
        if (data.inputUuid === 'desktop')
          return { inputSettings: { device_id: options.captureDevice ?? 'default' } };
        if (data.inputUuid === 'video') return { inputSettings: { capture_audio: false } };
        return {
          inputSettings: {
            url: scenes.find((scene) => scene.browserInput === data.inputUuid)?.browserUrl,
          },
        };
      }
      if (type === 'GetInputAudioMonitorType') {
        if (options.monitorFailure) throw new Error('unavailable');
        return { monitorType: options.monitor ?? 'OBS_MONITORING_TYPE_NONE' };
      }
      if (type === 'GetInputDefaultSettings')
        return { defaultInputSettings: { device_id: 'default' } };
      if (type === 'GetProfileParameter')
        return { parameterValue: options.monitorDevice ?? 'default' };
      if (type === 'GetInputMute') return { inputMuted: false };
      if (type === 'GetInputVolume') return { inputVolumeMul: 1 };
      if (type === 'GetInputAudioTracks') return { inputAudioTracks: { 1: true } };
      if (type === 'GetSceneItemList') {
        const scene = scenes.find((entry) => entry.sceneName === data.sceneName)!;
        return {
          sceneItems: [
            ...scene.sources.map((name, index) => ({
              sourceName: name,
              sourceUuid: name === OBS_CAPTURE_INPUT ? 'video' : name,
              sceneItemEnabled: true,
              sceneItemId: index + 1,
            })),
            {
              sourceName: '桌面声音',
              sourceUuid: 'desktop',
              sceneItemEnabled: true,
              sceneItemId: 100,
            },
            { sourceName: '麦克风', sourceUuid: 'mic', sceneItemEnabled: true, sceneItemId: 101 },
            {
              sourceName: '其他解说',
              sourceUuid: 'ts',
              sceneItemEnabled: Boolean(options.duplicate),
              sceneItemId: 102,
            },
          ],
        };
      }
      if (type === 'GetStreamStatus') {
        if (options.changed) listener?.({ type: 'outputStarting' });
        return { outputActive: Boolean(options.active) };
      }
      if (type === 'GetRecordStatus') return { outputActive: false };
      throw new Error(`unexpected ${type}`);
    },
  };
  const adopt = (
    adapter as unknown as {
      adoptInitialTeamspeakDesktop(
        obs: ObsRpc,
        endpoint: string,
        observer: MigrationObserver,
        valid: () => boolean,
      ): Promise<boolean>;
    }
  ).adoptInitialTeamspeakDesktop.bind(adapter);
  const check = (
    adapter as unknown as {
      configurationFindings(
        obs: ObsRpc,
        endpoint: string,
        visual: [],
      ): Promise<{ code: string; message: string }[]>;
    }
  ).configurationFindings.bind(adapter);
  return {
    adopt: () => adopt(obs, 'ws://127.0.0.1:4455', observer, () => true),
    check: () => check(obs, 'ws://127.0.0.1:4455', []),
    obs,
    routing,
    owner,
    calls,
    dir,
  };
}

it('distinguishes the modern executable from TS3 without claiming a precise version', () => {
  expect(isModernTeamspeak('TeamSpeak:Qt:teamspeak.exe')).toBe(true);
  expect(isModernTeamspeak('TeamSpeak:Qt:ts3client_win64.exe')).toBe(false);
  expect(isTeamspeak('TeamSpeak:Qt:ts3client_win64.exe')).toBe(true);
  expect(isModernTeamspeak('bad:teamspeak.exe')).toBe(false);
});

it('records the verified initial desktop and microphone without writing to OBS, and persists it', async () => {
  const f = await fixture();
  expect(await f.adopt()).toBe(true);
  expect(f.calls.every((call) => call.startsWith('Get'))).toBe(true);
  expect((await f.routing.modeRecoveryState()).desktop?.inputUuid).toBe('desktop');
  expect((await f.routing.modeRecoveryState()).desktopMicrophone?.inputUuid).toBe('mic');
  expect(
    (await new ObsAudioRouting(join(f.dir, 'routing.json')).modeRecoveryState()).desktop?.inputUuid,
  ).toBe('desktop');
});

it.each([{ active: true }, { duplicate: true }, { changed: true }])(
  'leaves routing untouched for output, duplicate audio or an observed change: %j',
  async (options) => {
    const f = await fixture(options);
    expect(await f.adopt()).toBe(false);
    expect(await f.routing.desktopBinding()).toBeNull();
    expect(await f.routing.automaticDesktopRevision()).not.toBeNull();
  },
);

it.each([
  {
    monitor: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    captureDevice: 'default',
    monitorDevice: 'default',
  },
  {
    monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
    captureDevice: 'device-a',
    monitorDevice: 'default',
  },
  { monitorFailure: true },
])(
  'keeps routing unconfirmed and warns when microphone monitoring may loop: %j',
  async (options) => {
    const f = await fixture(options);
    expect(await f.adopt()).toBe(false);
    expect(await f.routing.desktopBinding()).toBeNull();
    const warning = (await f.check()).filter(
      (finding) => finding.code === 'audio_teamspeak_compatibility',
    );
    expect(warning).toHaveLength(1);
    expect(warning[0]?.message).toContain('麦克风监听可能');
    expect(f.calls.every((call) => call.startsWith('Get'))).toBe(true);
  },
);

it('allows monitoring when capture and monitoring devices are known to differ', async () => {
  const f = await fixture({
    monitor: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    captureDevice: 'device-a',
    monitorDevice: 'device-b',
  });
  expect(await f.adopt()).toBe(true);
});

it('retains one compatibility warning across repeated status checks for desktop and independent modes', async () => {
  const desktop = await fixture();
  expect(await desktop.adopt()).toBe(true);
  for (let i = 0; i < 2; i++) {
    const warnings = (await desktop.check()).filter(
      (finding) => finding.code === 'audio_teamspeak_compatibility',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('当前为桌面混音');
  }
  const independent = await fixture();
  await independent.routing.seedAutomatic(independent.obs, 'ws://127.0.0.1:4455', {
    game: 'game',
    remoteCommentary: 'ts',
    microphone: 'mic',
  });
  for (let i = 0; i < 2; i++) {
    const warnings = (await independent.check()).filter(
      (finding) => finding.code === 'audio_teamspeak_compatibility',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('独立采集可能没有远端人声');
  }
});

it('preserves explicitly selected commentary and any previously saved routing', async () => {
  const f = await fixture();
  const preference = await f.owner.get();
  await f.owner.set(
    { mode: 'application', window: 'TeamSpeak:Qt:teamspeak.exe' },
    preference.revision,
  );
  expect(await f.adopt()).toBe(false);
  const revision = await f.routing.automaticDesktopRevision();
  await f.routing.adoptInitialDesktop(
    revision!,
    {
      inputUuid: 'other',
      inputKind: 'wasapi_output_capture',
      endpoint: 'ws://127.0.0.1:4455',
      collection: 'Mizar',
    },
    {
      inputUuid: 'mic',
      inputKind: 'wasapi_input_capture',
      endpoint: 'ws://127.0.0.1:4455',
      collection: 'Mizar',
    },
  );
  const reopened = new ObsAudioRouting(join(f.dir, 'routing.json'));
  expect(await reopened.automaticDesktopRevision()).toBeNull();
  expect((await reopened.desktopBinding())?.inputUuid).toBe('other');
});
