import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MusicPreviewRequest } from '@mizar/protocol/music';
import { desiredMusicMonitorMode, type MusicTruth } from '../src/music/cues.js';
import type { MusicDevice, MusicMonitorMode } from '../src/music/device.js';
import { MusicDirector } from '../src/music/director.js';
import { MusicStore } from '../src/music/store.js';
import { ensureManagedAudioSources, checkObsAudio } from '../src/obs/audio.js';
import { readAudioDevices, setAudioDevice } from '../src/obs/audio-device-settings.js';
import { AudioMigration } from '../src/obs/audio-migration.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import { createMusicDevice } from '../src/obs/music-device.js';

async function createMusicRig(
  t: import('node:test').TestContext,
  truth: () => MusicTruth,
  overrides: Partial<MusicDevice> & { epoch?: () => number } = {},
) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-music-rig-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  const device: Partial<MusicDevice> = {
    hasSource: async () => true,
    monitorMode: async () => 'monitor-and-output',
    setMonitorMode: async () => {},
    mediaStatus: async () => ({ state: 'stopped', cursorMs: 0, durationMs: 0 }),
    mute: async () => false,
    volume: async () => 1,
    mediaFile: async () => '',
    loadMedia: async () => {},
    controlMedia: async () => {},
    setVolume: async () => {},
    setMute: async () => {},
    verifyPlayback: async () => {},
    outputsStopped: async () => true,
    prepareResources: async () => {},
    ...overrides,
    checkCalls: () => device as unknown as MusicDevice,
  };
  let now = 1000;
  const director = new MusicDirector(
    store,
    {
      collectionRevision: 1,
      session: (run) => run(device as unknown as MusicDevice, overrides.epoch?.() ?? 1),
      close: async () => {},
    },
    truth,
    () => now,
  );
  return {
    directory,
    store,
    director,
    tick: (stepMs = 500) => ((now += stepMs), director.tick()),
    now: () => now,
  };
}

test('default device, custom scene items, auto-prepare stinger, audition lifecycle, and single-layer fault isolation', async (t) => {
  // 1. Default device switching & custom scene items in checkObsAudio / ensureManagedAudioSources.
  const scenes = obsDesiredScenes('http://127.0.0.1:3000').map((s) => ({ sceneName: s.sceneName }));
  const inputs: { inputName: string; inputKind: string; inputUuid: string }[] = [
    { inputName: 'Custom Camera', inputKind: 'dshow_input', inputUuid: 'custom-cam' },
  ];
  const monitorTypes = new Map<string, string>();
  const deviceIds = new Map<string, string>();
  const sceneItems = new Map<
    string,
    { sourceName: string; sourceUuid: string; sceneItemId: number; sceneItemEnabled: boolean }[]
  >();
  for (const s of scenes) {
    sceneItems.set(s.sceneName, [
      {
        sourceName: 'Custom Camera',
        sourceUuid: 'custom-cam',
        sceneItemId: 1,
        sceneItemEnabled: true,
      },
    ]);
  }
  let nextItemId = 2;
  const obs = {
    ownershipScope: async () => 'scope-1',
    managedInputIdentity: async (name: string) => {
      const found = inputs.find((i) => i.inputName === name);
      return found ? { uuid: found.inputUuid, kind: found.inputKind } : null;
    },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'GetSceneCollectionList')
        return { currentSceneCollectionName: OBS_COLLECTION };
      if (method === 'GetSceneList') return { scenes };
      if (method === 'GetInputList') return { inputs };
      if (method === 'GetSpecialInputs') return {};
      if (method === 'GetStreamStatus') return { outputActive: false };
      if (method === 'GetRecordStatus') return { outputActive: false };
      if (method === 'GetOutputList') return { outputs: [] };
      if (method === 'GetProfileParameter') return { parameterValue: '1' };
      if (method === 'GetCurrentProgramScene')
        return { currentProgramSceneName: scenes[0]!.sceneName };
      if (method === 'GetSceneItemList')
        return { sceneItems: sceneItems.get(params.sceneName as string) ?? [] };
      if (method === 'CreateInput') {
        const uuid = `uuid-${inputs.length + 1}`;
        const row = {
          inputName: params.inputName as string,
          inputKind: params.inputKind as string,
          inputUuid: uuid,
        };
        inputs.push(row);
        deviceIds.set(uuid, 'default');
        monitorTypes.set(uuid, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
        sceneItems.get(params.sceneName as string)!.push({
          sourceName: row.inputName,
          sourceUuid: uuid,
          sceneItemId: nextItemId++,
          sceneItemEnabled: Boolean(params.sceneItemEnabled),
        });
        return { inputUuid: uuid, sceneItemId: nextItemId - 1 };
      }
      if (method === 'CreateSceneItem') {
        const found = inputs.find((i) => i.inputName === params.sourceName)!;
        const itemId = nextItemId++;
        sceneItems.get(params.sceneName as string)!.push({
          sourceName: found.inputName,
          sourceUuid: found.inputUuid,
          sceneItemId: itemId,
          sceneItemEnabled: Boolean(params.sceneItemEnabled),
        });
        return { sceneItemId: itemId };
      }
      if (method === 'SetSceneItemEnabled') {
        const list = sceneItems.get(params.sceneName as string) ?? [];
        const item = list.find((entry) => entry.sceneItemId === params.sceneItemId);
        if (item) item.sceneItemEnabled = Boolean(params.sceneItemEnabled);
        return {};
      }
      if (method === 'SetInputAudioMonitorType') {
        monitorTypes.set(params.inputUuid as string, params.monitorType as string);
        return {};
      }
      if (method === 'GetInputAudioMonitorType')
        return {
          monitorType: monitorTypes.get(params.inputUuid as string) ?? 'OBS_MONITORING_TYPE_NONE',
        };
      if (method === 'GetInputSettings') {
        const uuid =
          (params.inputUuid as string | undefined) ??
          inputs.find((i) => i.inputName === params.inputName)!.inputUuid;
        return { inputSettings: { device_id: deviceIds.get(uuid) ?? 'default' } };
      }
      if (method === 'SetInputSettings') {
        deviceIds.set(
          params.inputUuid as string,
          (params.inputSettings as { device_id: string }).device_id,
        );
        return {};
      }
      if (method === 'GetInputPropertiesListPropertyItems')
        return {
          propertyItems: [
            { itemName: 'Default', itemValue: 'default', itemEnabled: true },
            { itemName: 'Speakers', itemValue: 'speakers-id', itemEnabled: true },
          ],
        };
      if (method === 'GetInputMute') return { inputMuted: false };
      if (method === 'GetInputVolume') return { inputVolumeMul: 1 };
      if (method === 'GetInputAudioTracks') return { inputAudioTracks: { '1': true } };
      throw new Error(`Unexpected OBS call: ${method}`);
    },
  };

  const created = await ensureManagedAudioSources(obs as never, 'http://127.0.0.1:3000', true);
  assert.equal(monitorTypes.get(created.desktop), 'OBS_MONITORING_TYPE_NONE');
  assert.equal(monitorTypes.get(created.microphone), 'OBS_MONITORING_TYPE_NONE');
  const initialDevices = await readAudioDevices(obs as never);
  const switched = await setAudioDevice(obs as never, {
    revision: initialDevices.revision,
    role: 'desktop',
    deviceId: 'speakers-id',
  });
  const backToDefault = await setAudioDevice(obs as never, {
    revision: switched.revision,
    role: 'desktop',
    deviceId: 'default',
  });
  assert.equal(backToDefault.devices.find((d) => d.role === 'desktop')?.deviceId, 'default');
  assert.deepEqual(
    (await checkObsAudio(obs as never)).filter((f) => f.code !== 'audio_stream_tracks_unknown'),
    [],
  );

  // 2. Auto-prepare missing stinger, monitor_unavailable failure + retry, stop polling + restore, and single-layer fault isolation.
  const track = { id: `${'f'.repeat(64)}.mp3`, name: 'Track', startMs: 0, endMs: null, gain: 1 };
  let stingerPrepared = false;
  let stingerState: 'stopped' | 'playing' = 'stopped';
  let stingerStopPolls = 0;
  let stingerMode: MusicMonitorMode = 'off';
  let bgmMode: MusicMonitorMode = 'off';
  let stingerFile = '';
  let stingerVol = 1;
  let failStingerWrite = true;
  let failBgmRead = false;
  let outputsIdle = true;
  const rig = await createMusicRig(
    t,
    () => ({
      active: 'waiting',
      production: true,
      program: {
        map: { name: 'de_test', phase: 'warmup', roundNumber: 0, score: { ct: 0, t: 0 } },
        cursor: { mapEpoch: 1 },
        match: { matchId: 'm1' },
        series: {
          bindingState: 'bound',
          currentMapOrder: 1,
          entrants: { a: { entryId: 'a' }, b: { entryId: 'b' } },
        },
        clock: null,
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
      } as MusicTruth['program'],
    }),
    {
      hasSource: async (_s, layer) => layer === 'bgm' || stingerPrepared,
      prepareResources: async (s, layer) => {
        if (layer === 'stinger') {
          stingerPrepared = true;
          await s.update((state) => {
            state.sources.stinger = 'stinger-uuid';
            state.sourceScopes.stinger = 'owned-collection';
          });
        }
      },
      outputsStopped: async () => outputsIdle,
      ownershipScope: async () => 'owned-collection',
      mediaFile: async () => stingerFile,
      volume: async () => stingerVol,
      setVolume: async ({ gain }) => {
        stingerVol = gain;
      },
      monitorMode: async ({ sourceId }) => {
        if (sourceId === 'bgm-uuid') {
          if (failBgmRead) throw new Error('bgm_read_failed');
          return bgmMode;
        }
        return stingerMode;
      },
      setMonitorMode: async ({ sourceId, mode }) => {
        if (sourceId === 'stinger-uuid') {
          if (failStingerWrite) throw new Error('obs_monitor_write_failed');
          stingerMode = mode;
        } else {
          bgmMode = mode;
        }
      },
      loadMedia: async ({ path }) => {
        stingerFile = path;
      },
      controlMedia: async ({ action }) => {
        if (action === 'restart') stingerState = 'playing';
        if (action === 'stop') stingerStopPolls = 0;
      },
      mediaStatus: async ({ sourceId }) => {
        if (sourceId === 'stinger-uuid' && stingerState === 'playing') {
          stingerStopPolls++;
          if (stingerStopPolls >= 2) stingerState = 'stopped';
        }
        return {
          state: sourceId === 'stinger-uuid' ? stingerState : 'stopped',
          cursorMs: 100,
          durationMs: 10_000,
        };
      },
    },
  );
  rig.store.trackPath = async () => '/tmp/fake-track.mp3';
  await rig.store.update((s) => {
    s.monitorPreference = false;
    s.sources.bgm = 'bgm-uuid';
    s.sourceScopes.bgm = 'owned-collection';
  });

  const makeReq = (operation: number, action: 'start' | 'stop' = 'start'): MusicPreviewRequest => ({
    action,
    owner: '11111111-1111-4111-8111-111111111111',
    token: '22222222-2222-4222-8222-222222222222',
    operation,
    expiresAt: rig.now() + 3000,
    group: 'waiting',
    track,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    confirmed: false,
  });

  // First preview auto-prepares missing stinger, hits monitor write failure, and fails cleanly.
  await rig.director.previewRequest(makeReq(1, 'start'));
  assert.equal(stingerPrepared, true);
  assert.equal(rig.director.get().preview?.phase, 'failed');

  // Retry succeeds even when BGM monitor read fails (single-layer isolation).
  failStingerWrite = false;
  failBgmRead = true;
  await rig.director.previewRequest(makeReq(2, 'start'));
  assert.equal(stingerMode, 'monitor-and-output');
  assert.equal(rig.director.get().monitor, 'unknown');

  // Explicit stop polls OBS media status and restores stinger to monitorPreference=false.
  await rig.director.command('stop');
  assert.equal(stingerState, 'stopped');
  assert.equal(stingerMode, 'off');

  // Resume, start preview again, then cancel via stop request -> restores stinger to off.
  await rig.director.command('resume');
  await rig.director.previewRequest(makeReq(3, 'start'));
  assert.equal(stingerMode, 'monitor-and-output');
  await rig.director.previewRequest(makeReq(4, 'stop'));
  await rig.tick();
  assert.equal(stingerMode, 'off');

  // Waiting for live-stream confirmation keeps stinger monitor at monitorPreference (off).
  await rig.director.command('resume');
  outputsIdle = false;
  await rig.director.previewRequest(makeReq(5, 'start'));
  assert.equal(rig.director.get().preview?.phase, 'confirmation');
  assert.equal(stingerMode, 'off');
  await rig.director.previewRequest(makeReq(6, 'stop'));
  outputsIdle = true;

  // Active opening blocks preview with music_preview_opening_busy.
  rig.director.opening('opening:active', track);
  await assert.rejects(
    rig.director.previewRequest(makeReq(7, 'start')),
    /music_preview_opening_busy/,
  );
});

test('monitorPreference is the single source of truth across mixed/failed writes and decouples mixer from routing', async (t) => {
  assert.equal(desiredMusicMonitorMode(true), 'monitor-and-output');
  assert.equal(desiredMusicMonitorMode(false), 'off');

  let bgmMode: MusicMonitorMode = 'off';
  let stingerMode: MusicMonitorMode = 'off';
  let failStingerReadback = true;
  let vol = 1;
  let inProduction = true;
  const rig = await createMusicRig(
    t,
    () => ({
      active: 'waiting',
      production: inProduction,
      program: {
        map: { name: 'de_test', phase: null },
        cursor: { mapEpoch: 1 },
        match: null,
        clock: null,
        status: { telemetry: 'fresh' },
      } as MusicTruth['program'],
    }),
    {
      volume: async () => vol,
      setVolume: async ({ gain }) => {
        vol = gain;
      },
      monitorMode: async ({ sourceId }) => (sourceId === 'bgm-uuid' ? bgmMode : stingerMode),
      setMonitorMode: async ({ sourceId, mode }) => {
        if (sourceId === 'bgm-uuid') bgmMode = mode;
        else if (!failStingerReadback) stingerMode = mode;
      },
    },
  );
  await rig.store.update((s) => {
    s.sources.bgm = 'bgm-uuid';
    s.sources.stinger = 'stinger-uuid';
    s.sourceScopes.bgm = 'owned-collection';
    s.sourceScopes.stinger = 'owned-collection';
  });

  // prepare() immediately applies monitorPreference to prepared sources.
  await rig.director.prepare(undefined, (run) =>
    run({
      hasSource: async () => true,
      prepareResources: async () => {},
      monitorMode: async ({ sourceId }: { sourceId?: string | null }) =>
        sourceId === 'bgm-uuid' ? bgmMode : stingerMode,
      setMonitorMode: async ({
        sourceId,
        mode,
      }: {
        sourceId?: string | null;
        mode: MusicMonitorMode;
      }) => {
        if (sourceId === 'bgm-uuid') bgmMode = mode;
        else if (!failStingerReadback) stingerMode = mode;
      },
    } as unknown as MusicDevice),
  );
  assert.equal(bgmMode, 'monitor-and-output');
  assert.equal(rig.director.get().monitor, 'mixed');

  // Explicit monitor(true) updates bgm even when stinger readback fails (mixed -> rejects).
  bgmMode = 'off';
  await assert.rejects(rig.director.monitor(true), /music_monitor_unconfirmed/);
  assert.equal(bgmMode, 'monitor-and-output');
  assert.equal(rig.director.get().monitorPreference, true);

  // Establish connected state first, then verify outside production (settings phase) connected tick() still syncs mismatched monitor.
  failStingerReadback = false;
  await rig.tick();
  assert.equal(rig.director.get().connection, 'connected');
  assert.equal(rig.director.get().monitor, 'enabled');

  inProduction = false;
  bgmMode = 'off';
  // Simulate drift observed via monitor(false) failure or external change:
  await assert.rejects(
    (async () => {
      failStingerReadback = true;
      await rig.director.monitor(false);
    })(),
    /music_monitor_unconfirmed/,
  );
  assert.equal(rig.director.get().monitor, 'mixed');
  failStingerReadback = false;
  await rig.tick();
  assert.equal(bgmMode, 'off');
  assert.equal(stingerMode, 'off');
  assert.equal(rig.director.get().monitor, 'disabled');

  // Restore monitorPreference=true for mixer check below.
  await rig.director.monitor(true);

  // Mixer channel works independently of OBS audio routing.
  await rig.director.setMixer(0.4, false);
  assert.equal(rig.director.mixerStatus().channel.volume, 0.4);
  assert.equal('desktopIncludesMusic' in rig.director.mixerStatus(), false);
});

test('legacy music state and .dedicated-mode monitor entries upgrade cleanly and switch back to independent mode', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-legacy-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // 1. Legacy music state.json with deprecated fields loads cleanly.
  const store = new MusicStore(directory);
  await store.load();
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({
      ...store.state,
      monitorDisablePending: true,
      previewMonitorLeases: [
        {
          uuid: 'stinger-uuid',
          scope: 'owned-collection',
          before: 'OBS_MONITORING_TYPE_NONE',
          applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
          phase: 'restoring',
        },
      ],
      desktopMonitorOriginal: {
        bgm: { uuid: 'bgm-uuid', mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
        stinger: null,
      },
      monitorConfigured: { bgm: 'bgm-uuid', stinger: null },
    }),
    'utf8',
  );
  const reloaded = new MusicStore(directory);
  await reloaded.load();
  assert.equal(reloaded.ready, true);
  assert.equal('monitorDisablePending' in reloaded.state, false);
  assert.equal('previewMonitorLeases' in reloaded.state, false);

  // 2. Legacy audio-routing.json with musicBefore/musicAfter deserializes cleanly.
  const routingPath = join(directory, 'audio-routing.json');
  await writeFile(
    routingPath,
    JSON.stringify({
      revision: '11111111-1111-4111-8111-111111111111',
      bindings: { game: null, remoteCommentary: null, microphone: null },
      transition: {
        id: '22222222-2222-4222-8222-222222222222',
        endpoint: 'ws://127.0.0.1:4455',
        collection: OBS_COLLECTION,
        targetDesktop: null,
        targetMicrophone: null,
        omitCommentary: false,
        musicBefore: { bgm: null, stinger: null },
        musicAfter: { bgm: { uuid: 'bgm-uuid', mode: 'OBS_MONITORING_TYPE_NONE' }, stinger: null },
      },
    }),
    'utf8',
  );
  const routing = new ObsAudioRouting(routingPath);
  const state = await routing.modeRecoveryState();
  assert.ok(state.transition && state.transition !== true);

  // 3. Legacy .dedicated-mode backup containing kind==='monitor' entries restores independent mode without touching OBS monitor types.
  const completedPath = join(directory, 'commentary.dedicated-mode');
  await writeFile(
    completedPath,
    JSON.stringify({
      modeId: '33333333-3333-4333-8333-333333333333',
      endpoint: 'ws://127.0.0.1:4455',
      collection: OBS_COLLECTION,
      fields: [
        {
          kind: 'monitor',
          inputUuid: 'bgm-uuid',
          before: 'OBS_MONITORING_TYPE_NONE',
          applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
          phase: 'confirmed',
          externalChanged: false,
        },
      ],
    }),
    'utf8',
  );
  const migration = new AudioMigration(join(directory, 'commentary.migration'));
  const obsCalls: string[] = [];
  const mockObs = {
    call: async (method: string) => {
      obsCalls.push(method);
      if (method === 'GetSceneCollectionList')
        return { currentSceneCollectionName: OBS_COLLECTION };
      if (method === 'GetInputList') return { inputs: [] };
      if (method === 'GetStreamStatus') return { outputActive: false };
      if (method === 'GetRecordStatus') return { outputActive: false };
      throw new Error(`Unexpected OBS call: ${method}`);
    },
  };
  await migration.rebindCompletedInputs(
    mockObs as never,
    completedPath,
    'ws://127.0.0.1:4455',
    OBS_COLLECTION,
    [{ before: 'bgm-uuid', after: 'bgm-new', kind: 'ffmpeg_source' }],
  );
  const restored = await migration.restoreCompleted(
    mockObs as never,
    'ws://127.0.0.1:4455',
    { subscribe: () => () => {} } as never,
    completedPath,
    [],
    '44444444-4444-4444-8444-444444444444',
  );
  assert.equal(restored, true);
  assert.equal(obsCalls.includes('SetInputAudioMonitorType'), false);
});

test('automatic music bounds collection probes, offline backoff, drift isolation, and manual pause/seek', async (t) => {
  // Offline OBS produces zero automatic RPCs and recovers cleanly on reconnect.
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-music-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  await store.update((s) => {
    s.sources.bgm = 'owned-source';
    s.sourceScopes.bgm = 'owned-collection';
  });
  let now = 0;
  let waitingForObs = true;
  let obsOffline = true;
  let sessionAttempts = 0;
  let rpcCalls = 0;
  const device = createMusicDevice({
    ownershipScope: async () => 'owned-collection',
    async call(method) {
      rpcCalls++;
      if (method === 'GetSceneCollectionList')
        return { currentSceneCollectionName: OBS_COLLECTION };
      if (method === 'GetInputList')
        return {
          inputs: [{ inputUuid: 'owned-source', inputName: 'BGM', inputKind: 'ffmpeg_source' }],
        };
      if (method === 'GetInputAudioMonitorType')
        return { monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' };
      if (method === 'GetInputVolume') return { inputVolumeMul: 0.5 };
      if (method === 'GetInputMute') return { inputMuted: false };
      if (method === 'GetMediaInputStatus')
        return { mediaState: 'OBS_MEDIA_STATE_STOPPED', mediaCursor: 0, mediaDuration: 0 };
      return {};
    },
  });
  const offlineDirector = new MusicDirector(
    store,
    {
      session: (run) => {
        sessionAttempts++;
        if (obsOffline) return Promise.reject(new Error('obs_disconnected'));
        return run(device, 1);
      },
      close: async () => {},
    },
    () =>
      ({
        active: 'waiting',
        production: true,
        program: {
          map: { name: 'de_test', phase: null },
          cursor: { mapEpoch: 1 },
          match: null,
          clock: null,
          status: { telemetry: 'fresh' },
        },
      }) as MusicTruth,
    () => now,
    Math.random,
    async () => false,
    () => waitingForObs,
  );
  for (let i = 0; i < 4; i++) {
    now += 250;
    await offlineDirector.tick();
  }
  assert.equal(sessionAttempts, 0);
  assert.equal(rpcCalls, 0);

  waitingForObs = false;
  now += 250;
  await offlineDirector.tick(true);
  assert.equal(sessionAttempts, 1);
  obsOffline = false;
  now += 5000;
  await offlineDirector.tick();
  assert.equal(offlineDirector.get().connection, 'connected');
  assert.equal(offlineDirector.get().failure, null);

  // Manual pause & seek fail closed to unknown control on write failure.
  const track = { id: `${'c'.repeat(64)}.mp3`, name: 'Track', startMs: 0, endMs: null, gain: 1 };
  let bgmState: 'playing' | 'paused' = 'playing';
  let bgmCursor = 500;
  let failSeek = false;
  const rig = await createMusicRig(
    t,
    () => ({
      active: 'waiting',
      production: true,
      program: {
        map: { name: 'de_test', phase: 'warmup', roundNumber: 0, score: { ct: 0, t: 0 } },
        cursor: { mapEpoch: 1 },
        match: { matchId: 'm1' },
        clock: null,
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
      } as MusicTruth['program'],
    }),
    {
      hasSource: async (_s, layer) => layer === 'bgm',
      mediaFile: async () => '/tmp/fake-track.mp3',
      mediaStatus: async () => ({ state: bgmState, cursorMs: bgmCursor, durationMs: 10_000 }),
      controlMedia: async ({ action }) => {
        if (action === 'pause') bgmState = 'paused';
        else if (action === 'play' || action === 'restart') bgmState = 'playing';
      },
      setMediaCursor: async ({ cursorMs }) => {
        if (failSeek) throw new Error('obs_seek_lost');
        bgmCursor = cursorMs;
      },
    },
  );
  rig.store.trackPath = async () => '/tmp/fake-track.mp3';
  await rig.store.update((s) => {
    s.sources.bgm = 'bgm-uuid';
    s.sourceScopes.bgm = 'owned-collection';
    s.config.groups.waiting = { ...s.config.groups.waiting, enabled: true, tracks: [track] };
  });
  await rig.director.manualPlay('waiting', track.id);
  await rig.director.manualPause(true);
  assert.equal(rig.director.get().playback, 'paused');
  await rig.director.manualPause(false);
  assert.equal(rig.director.get().playback, 'playing');
  const key = rig.store.state.bgm!.key;
  await rig.director.seek(3000, key);
  assert.equal(rig.director.get().cursorMs, 3000);
  failSeek = true;
  await assert.rejects(rig.director.seek(4000, key), /obs_seek_lost/);
  assert.equal(rig.director.get().playback, 'unknown');
  assert.equal(rig.director.get().held, true);
});
