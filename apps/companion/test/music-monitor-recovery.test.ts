import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MusicStore } from '../src/music/store.js';
import { PreviewMonitor } from '../src/music/preview-monitor.js';
import { OBS_COLLECTION } from '../src/obs/desired-state.js';
import { createMusicDevice } from '../src/obs/music-device.js';
import type { ObsRpc } from '../src/obs/reconcile.js';
import { MusicDirector } from '../src/music/director.js';
import type { MusicDevice, MusicDeviceProvider, MusicMonitorMode } from '../src/music/device.js';
import type { MusicTruth } from '../src/music/cues.js';

test('closing music monitor during route migration survives restart and applies on recovery', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-monitor-disable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  await store.update((state) => {
    state.sources.bgm = 'music-source';
    state.monitorPreference = true;
  });
  let migrating = true;
  let reconnecting = false;
  let sessions = 0;
  let mode: MusicMonitorMode = 'monitor-and-output';
  const device = {
    hasSource: async (_store, layer) => layer === 'bgm',
    monitorRelationship: async () => 'independent',
    setMonitorMode: async ({ sourceId, mode: next }) => {
      assert.equal(sourceId, 'music-source');
      mode = next;
    },
    monitorMode: async () => mode,
  } satisfies Pick<
    MusicDevice,
    'hasSource' | 'monitorRelationship' | 'setMonitorMode' | 'monitorMode'
  >;
  const provider: MusicDeviceProvider = {
    session: (run) => {
      sessions++;
      return run(device as unknown as MusicDevice, 1);
    },
    close: async () => {},
  };
  const director = (state: MusicStore) =>
    new MusicDirector(
      state,
      provider,
      () => assert.fail('unexpected automatic playback'),
      Date.now,
      Math.random,
      async () => migrating,
      () => reconnecting,
    );
  await director(store).monitor(false);
  assert.equal(sessions, 0);
  const reopened = new MusicStore(directory);
  await reopened.load();
  const resumed = director(reopened);
  assert.equal(reopened.state.monitorPreference, false);
  assert.equal(resumed.get().monitorDisablePending, true);
  migrating = false;
  reconnecting = true;
  await resumed.tick();
  assert.equal(sessions, 0);
  assert.equal(resumed.get().monitorDisablePending, true);
  reconnecting = false;
  await resumed.tick();
  assert.equal(mode, 'off');
  assert.equal(resumed.get().monitor, 'disabled');
  assert.equal(resumed.get().monitorDisablePending, undefined);
});

test('monitor restoration retains a lost receipt and confirms it by readback after restart', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-monitor-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  const uuid = 'audition-source';
  const scope = 'owned-collection';
  const before = 'OBS_MONITORING_TYPE_NONE';
  const applied = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
  await store.update((state) => {
    state.sources.stinger = uuid;
    state.sourceScopes.stinger = scope;
    state.previewMonitorLeases = [{ uuid, scope, before, applied, phase: 'borrowed' }];
  });

  let current = true;
  let writes = 0;
  let mode: string = applied;
  const obs: ObsRpc = {
    reportsDispatch: true,
    ownershipScope: async () => scope,
    withMutationGuard: (guard) => ({
      ...obs,
      call: async (method, input, dispatch) => {
        await Promise.resolve();
        if (method === 'SetInputAudioMonitorType') {
          current = false;
          guard();
        }
        return obs.call(method, input, dispatch);
      },
    }),
    call: async (method, input, dispatch) => {
      if (method === 'GetSceneCollectionList')
        return { currentSceneCollectionName: OBS_COLLECTION };
      if (method === 'GetInputList')
        return { inputs: [{ inputUuid: uuid, inputName: '音效', inputKind: 'ffmpeg_source' }] };
      if (method === 'GetInputAudioMonitorType') return { monitorType: mode };
      if (method === 'GetMediaInputStatus') return { mediaState: 'OBS_MEDIA_STATE_STOPPED' };
      if (method !== 'SetInputAudioMonitorType') throw new Error(`Unexpected request: ${method}`);
      assert.equal(input?.inputUuid, uuid);
      assert.equal(input?.monitorType, before);
      dispatch?.();
      writes++;
      mode = before;
      throw new Error('OBS reply lost after applying the monitor mode');
    },
  };
  const monitor = new PreviewMonitor(store, async () => null);
  const device = createMusicDevice(obs);
  assert.equal(await monitor.restore(device, () => current), false);
  assert.equal(writes, 0);
  assert.equal(store.state.previewMonitorLeases[0]?.phase, 'borrowed');

  // The next attempt is dispatched, but its result is unknown until the new owner reads it.
  assert.equal(await monitor.restore(device, () => true), false);
  assert.equal(writes, 1);
  const reopened = new MusicStore(directory);
  await reopened.load();
  assert.equal(reopened.state.previewMonitorLeases[0]?.phase, 'restoring');
  const recovery = new PreviewMonitor(reopened, async () => null);
  assert.equal(await recovery.restore(device, () => true), true);
  assert.deepEqual(reopened.state.previewMonitorLeases, []);
  assert.equal(writes, 1);
});

test('automatic music bounds collection probes while telemetry changes and retries on collection recovery', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-music-cooldown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  await store.update((state) => {
    state.sources.bgm = 'owned-source';
  });
  let now = 0;
  let collectionRevision = 1;
  let collectionReads = 0;
  let inactive = true;
  let rpcTimeout = false;
  let monitorReads = 0;
  const stinger = 'audition-source';
  const scope = 'owned-collection';
  const before = 'OBS_MONITORING_TYPE_NONE';
  const device = createMusicDevice({
    ownershipScope: async () => scope,
    async call(method) {
      if (method === 'GetSceneCollectionList') {
        collectionReads++;
        if (rpcTimeout) throw new Error('music_obs_timeout');
        return { currentSceneCollectionName: inactive ? 'Personal' : OBS_COLLECTION };
      }
      if (method === 'GetInputList')
        return { inputs: [{ inputUuid: stinger, inputName: '音效', inputKind: 'ffmpeg_source' }] };
      if (method === 'GetInputAudioMonitorType') {
        monitorReads++;
        return { monitorType: before };
      }
      assert.fail(`Unexpected OBS request: ${method}`);
    },
  });
  const provider: MusicDeviceProvider = {
    get collectionRevision() {
      return collectionRevision;
    },
    session: (run) => run(device, 1),
    close: async () => {},
  };
  let production = false;
  const truth = (): MusicTruth => ({
    active: 'waiting',
    production,
    program: {
      map: { name: 'de_test', phase: null },
      cursor: { mapEpoch: now / 100 },
      match: null,
      clock: null,
      status: { telemetry: 'fresh' },
    } as MusicTruth['program'],
  });
  const director = new MusicDirector(store, provider, truth, () => now);
  await director.tick();
  assert.equal(collectionReads, 0);
  production = true;
  for (; now < 60000; now += 100) await director.tick();
  assert.ok(collectionReads >= 4 && collectionReads <= 10, `got ${collectionReads} probes`);
  const beforeExplicit = collectionReads;
  await director.tick(true);
  assert.equal(collectionReads, beforeExplicit + 1);
  inactive = false;
  collectionRevision++;
  now += 100;
  await director.tick();
  assert.ok(collectionReads > beforeExplicit + 1);
  const afterRecovery = collectionReads;
  now += 100;
  await director.tick();
  assert.ok(collectionReads > afterRecovery);

  rpcTimeout = true;
  const beforeTimeout = collectionReads;
  const started = now;
  for (; now < started + 60_000; now += 100) await director.tick();
  assert.ok(collectionReads - beforeTimeout >= 4 && collectionReads - beforeTimeout <= 10);
  assert.equal(director.get().connection, 'connected');
  assert.equal(director.get().failure, 'playback_failed');

  // Refresh the automatic cooldown, then allow a readback of an owned preview lease.
  await director.tick(true);
  await store.update((state) => {
    state.sources.stinger = stinger;
    state.sourceScopes.stinger = scope;
    state.previewMonitorLeases = [
      {
        uuid: stinger,
        scope,
        before,
        applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
        phase: 'restoring',
      },
    ];
  });
  rpcTimeout = false;
  now += 2000;
  await director.tick();
  assert.equal(monitorReads, 1);
  assert.deepEqual(store.state.previewMonitorLeases, []);
  const afterCleanup = collectionReads;
  now += 100;
  await director.tick();
  assert.equal(collectionReads, afterCleanup);
});

test('offline OBS produces zero automatic RPCs or failure diagnostics, aggregates disconnect retries, and preserves explicit operations', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-music-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  await store.update((state) => {
    state.sources.bgm = 'owned-source';
    state.sourceScopes.bgm = 'owned-collection';
  });
  let now = 0;
  let waitingForObs = true;
  let obsOffline = true;
  let sessionAttempts = 0;
  let rpcCalls = 0;
  let nextConnectionAttemptAt = 0;
  const diagnostics: { stage: string; evidence: unknown }[] = [];

  const device = createMusicDevice({
    ownershipScope: async () => 'owned-collection',
    async call(method) {
      rpcCalls++;
      if (method === 'GetSceneCollectionList') {
        return { currentSceneCollectionName: OBS_COLLECTION };
      }
      if (method === 'GetSceneList') {
        return { scenes: [] };
      }
      if (method === 'GetSceneItemList') {
        return { sceneItems: [] };
      }
      if (method === 'GetInputSettings') {
        return { inputSettings: {} };
      }
      if (method === 'GetInputList') {
        return {
          inputs: [{ inputUuid: 'owned-source', inputName: 'BGM', inputKind: 'ffmpeg_source' }],
        };
      }
      if (method === 'GetInputAudioMonitorType') {
        return { monitorType: 'OBS_MONITORING_TYPE_NONE' };
      }
      if (method === 'GetInputVolume') {
        return { inputVolumeDb: -6, inputVolumeMul: 0.5 };
      }
      if (method === 'GetInputMute') {
        return { inputMuted: false };
      }
      if (method === 'GetMediaInputStatus') {
        return { mediaState: 'OBS_MEDIA_STATE_STOPPED', mediaDuration: 0, mediaCursor: 0 };
      }
      throw new Error(`Unexpected OBS request: ${method}`);
    },
  });
  const provider: MusicDeviceProvider = {
    collectionRevision: 1,
    get nextConnectionAttemptAt() {
      return nextConnectionAttemptAt;
    },
    session: async (run) => {
      sessionAttempts++;
      if (obsOffline) {
        nextConnectionAttemptAt = now + 2000;
        throw new Error('music_obs_unavailable');
      }
      return run(device, 1);
    },
    close: async () => {},
  };
  const truth = (): MusicTruth => ({
    active: 'waiting',
    production: true,
    program: {
      map: { name: 'de_test', phase: null },
      cursor: { mapEpoch: 1 },
      match: null,
      clock: null,
      status: { telemetry: 'fresh' },
    } as MusicTruth['program'],
  });

  const director = new MusicDirector(
    store,
    provider,
    truth,
    () => now,
    Math.random,
    async () => false,
    () => waitingForObs,
  );
  const originalPreviewEvent = store.previewEvent.bind(store);
  store.previewEvent = (stage, evidence) => {
    diagnostics.push({ stage, evidence });
    originalPreviewEvent(stage, evidence);
  };

  // 1. OBS not started: waitingForObs = true -> 0 session attempts, 0 RPCs, 0 failure diagnostics
  for (let i = 0; i < 20; i++) {
    now += 250;
    await director.tick();
  }
  assert.equal(sessionAttempts, 0);
  assert.equal(rpcCalls, 0);
  assert.equal(diagnostics.length, 0);

  // 2. Explicit tick(true) bypasses waitingForObs and surfaces real unavailable error
  now += 250;
  await director.tick(true);
  assert.equal(sessionAttempts, 1);
  assert.equal(rpcCalls, 0);
  assert.equal(diagnostics.filter((d) => d.stage === 'music_operation_failed').length, 1);

  // 3. Disconnect / slow start while waitingForObs = false: backoff bounds session attempts & RepeatedDiagnostic suppresses duplicates
  waitingForObs = false;
  for (let i = 0; i < 20; i++) {
    now += 250;
    await director.tick();
  }
  assert.ok(sessionAttempts <= 4, `expected bounded reconnect attempts, got ${sessionAttempts}`);
  assert.equal(diagnostics.filter((d) => d.stage === 'music_operation_failed').length, 1);

  // 4. Reconnect: clears failure and emits music_operation_recovered
  obsOffline = false;
  nextConnectionAttemptAt = 0;
  now += 5000;
  await director.tick();
  assert.equal(director.get().connection, 'connected');
  assert.equal(director.get().failure, null);
  assert.equal(diagnostics.filter((d) => d.stage === 'music_operation_recovered').length, 1);
});
