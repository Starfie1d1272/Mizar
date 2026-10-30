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

async function fixture(options: { active?: boolean; duplicate?: boolean; changed?: boolean } = {}) {
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
  ];
  const calls: string[] = [];
  const obs: ObsRpc = {
    async call(type, data = {}) {
      calls.push(type);
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetSpecialInputs') return {};
      if (type === 'GetInputList') return { inputs };
      if (type === 'GetSceneList')
        return { scenes: scenes.map((scene) => ({ sceneName: scene.sceneName })) };
      if (type === 'GetInputSettings') {
        if (data.inputUuid === 'ts')
          return { inputSettings: { window: 'TeamSpeak:Qt:teamspeak.exe' } };
        if (data.inputUuid === 'video') return { inputSettings: { capture_audio: false } };
        return {
          inputSettings: {
            url: scenes.find((scene) => scene.browserInput === data.inputUuid)?.browserUrl,
          },
        };
      }
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
  return {
    adopt: () => adopt(obs, 'ws://127.0.0.1:4455', observer, () => true),
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
