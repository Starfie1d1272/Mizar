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
  const device: Partial<MusicDevice> = {
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
      const responses: Record<string, Record<string, unknown>> = {
        GetSceneCollectionList: { currentSceneCollectionName: OBS_COLLECTION },
        GetSceneList: { scenes: [] },
        GetSceneItemList: { sceneItems: [] },
        GetInputSettings: { inputSettings: {} },
        GetInputList: {
          inputs: [{ inputUuid: 'owned-source', inputName: 'BGM', inputKind: 'ffmpeg_source' }],
        },
        GetInputAudioMonitorType: { monitorType: 'OBS_MONITORING_TYPE_NONE' },
        GetInputVolume: { inputVolumeDb: -6, inputVolumeMul: 0.5 },
        GetInputMute: { inputMuted: false },
        GetMediaInputStatus: {
          mediaState: 'OBS_MEDIA_STATE_STOPPED',
          mediaDuration: 0,
          mediaCursor: 0,
        },
      };
      if (method in responses) return responses[method]!;
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
    monitorRelationship: async () => 'independent',
    monitorSafe: async () => true,
    monitorMode: async () => 'monitor-and-output',
    setMonitorMode: async () => {},
    readManagedMonitorModes: async () => ['monitor-and-output'],
    mediaStatus: async () => ({ state: 'stopped', cursorMs: 0, durationMs: 0 }),
    mute: async () => false,
    volume: async () => 1,
    mediaFile: async () => '',
    loadMedia: async () => {},
    controlMedia: async () => {},
    setVolume: async () => {},
    setMute: async () => {},
    verifyPlayback: async () => {},
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
  return { store, director, tick: (stepMs = 500) => ((now += stepMs), director.tick()) };
}

test('monitor(true) leaves monitorConfigured unset while unknown, requires readback, and applies once different', async (t) => {
  let relationship: 'unknown' | 'different' = 'unknown';
  let actualMode: MusicMonitorMode = 'off';
  let failReadback = true;
  const writes: MusicMonitorMode[] = [];
  const rig = await createMusicRig(
    t,
    () => ({
      active: 'waiting',
      production: true,
      program: {
        map: { name: 'de_test', phase: null },
        cursor: { mapEpoch: 1 },
        match: null,
        clock: null,
        status: { telemetry: 'fresh' },
      } as MusicTruth['program'],
    }),
    {
      hasSource: async (_s, layer) => layer === 'bgm',
      monitorRelationship: async () => relationship,
      readManagedMonitorModes: async () => [actualMode],
      monitorMode: async () => actualMode,
      setMonitorMode: async ({ mode }) => {
        writes.push(mode);
        if (!failReadback) actualMode = mode;
      },
    },
  );
  await rig.store.update((s) => {
    s.sources.bgm = 'bgm-uuid';
    s.sourceScopes.bgm = 'owned-collection';
  });
  await rig.director.monitor(true);
  assert.deepEqual(writes, []);
  assert.equal(rig.store.state.monitorConfigured.bgm, null);
  assert.equal(rig.director.get().monitorPending, true);

  relationship = 'different';
  rig.director.noteMonitorSettingsChanged();
  await rig.tick();
  assert.deepEqual(writes, ['monitor-and-output']);
  assert.equal(rig.store.state.monitorConfigured.bgm, null);

  failReadback = false;
  rig.director.noteMonitorSettingsChanged();
  await rig.tick();
  assert.equal(rig.store.state.monitorConfigured.bgm, 'bgm-uuid');
  assert.equal(rig.director.get().monitor, 'enabled');
  assert.equal(rig.director.get().monitorPending, false);
});

test('transient media states and stinger control isolate stingerHeld without falsely holding BGM, and drift requires two independent ticks', async (t) => {
  const track = { id: `${'b'.repeat(64)}.mp3`, name: 'Track', startMs: 0, endMs: null, gain: 1 };
  let bgmState: 'opening' | 'playing' | 'paused' = 'opening';
  let bgmVolume = 0;
  let stingerState: 'stopped' | 'paused' = 'stopped';
  let epoch = 1;
  let phase: 'warmup' | 'live' = 'live';
  let active: 'waiting' | 'gameplay' = 'gameplay';
  let bgmMediaReads = 0;
  const rig = await createMusicRig(
    t,
    () => ({
      active,
      production: true,
      program: {
        map: { name: 'de_test', phase, roundNumber: 0, score: { ct: 0, t: 0 } },
        cursor: { mapEpoch: 1 },
        match: { matchId: 'm1' },
        series: {
          bindingState: 'bound',
          currentMapOrder: 1,
          entrants: { a: { entryId: 'a' }, b: { entryId: 'b' } },
        },
        clock: { phase: 'live' },
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
      } as MusicTruth['program'],
    }),
    {
      epoch: () => epoch,
      mediaStatus: async ({ sourceId }) => {
        if (sourceId === 'bgm-uuid') bgmMediaReads++;
        return sourceId === 'stinger-uuid'
          ? { state: stingerState, cursorMs: 0, durationMs: 5000 }
          : { state: bgmState, cursorMs: 0, durationMs: 10_000 };
      },
      volume: async ({ sourceId }) => (sourceId === 'stinger-uuid' ? 1 : bgmVolume),
      mediaFile: async () => '/tmp/fake-track.mp3',
      setVolume: async ({ sourceId, gain }) => {
        if (sourceId === 'bgm-uuid') bgmVolume = gain;
      },
      controlMedia: async ({ sourceId, action }) => {
        if (sourceId === 'stinger-uuid' && action === 'restart') stingerState = 'paused';
      },
    },
  );
  rig.store.trackPath = async () => '/tmp/fake-track.mp3';
  await rig.store.update((s) => {
    s.sources.bgm = 'bgm-uuid';
    s.sources.stinger = 'stinger-uuid';
    s.sourceScopes.bgm = 'owned-collection';
    s.sourceScopes.stinger = 'owned-collection';
    s.config.groups.waiting = { ...s.config.groups.waiting, enabled: true, tracks: [track] };
    s.config.groups.opening = { ...s.config.groups.opening, enabled: true, tracks: [track] };
    s.bgm = {
      group: 'waiting',
      key: 'waiting:m1',
      track,
      configRevision: s.configRevision,
      finished: false,
      suspended: false,
      cursorMs: 0,
    };
  });

  // Opening/buffering mismatch and single-tick drift do not hold; steady tick reads BGM media once; reconnect clears drift counter.
  bgmMediaReads = 0;
  await rig.tick();
  assert.equal(bgmMediaReads, 1);
  assert.equal(rig.director.get().held, false);
  bgmState = 'playing';
  bgmVolume = 0.2;
  await rig.tick();
  assert.equal(rig.director.get().held, false);
  epoch = 2;
  bgmVolume = rig.store.state.master;
  await rig.tick();
  assert.equal(rig.director.get().held, false);

  // External pause on stinger holds ONLY stinger; real pause on BGM holds BGM cleanly.
  stingerState = 'paused';
  await rig.tick();
  assert.equal(rig.director.get().stingerHeld, true);
  assert.equal(rig.director.get().held, false);

  await rig.store.hold(false);
  stingerState = 'stopped';
  bgmState = 'paused';
  await rig.tick();
  assert.equal(rig.director.get().held, true);
  assert.equal(rig.director.get().stingerHeld, false);

  // Active BGM cue: 1 tick of drift across observeManualControls()+layer() does NOT hold, 2nd tick holds; stinger waitAfterRestart pause stays isolated.
  await rig.director.command('resume');
  active = 'waiting';
  phase = 'warmup';
  bgmState = 'playing';
  bgmVolume = 1;
  await rig.tick();
  bgmVolume = 0.25;
  await rig.tick();
  assert.equal(rig.director.get().held, false);
  await rig.tick();
  assert.equal(rig.director.get().held, true);

  bgmVolume = rig.store.state.master;
  await rig.director.command('resume');
  rig.director.opening('opening:1', track);
  await rig.tick();
  assert.equal(rig.director.get().stingerHeld, true);
  assert.equal(rig.director.get().held, false);
});

test('manualPause and seek confirm playback transitions and fail closed to unknown control on write failure', async (t) => {
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
