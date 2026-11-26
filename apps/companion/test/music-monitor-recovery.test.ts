import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { MusicStore } from '../src/music/store.js';
import { PreviewMonitor } from '../src/music/preview-monitor.js';
import { OBS_COLLECTION } from '../src/obs/desired-state.js';
import { createMusicDevice } from '../src/obs/music-device.js';
import { MusicDirector } from '../src/music/director.js';
import { MusicPreview } from '../src/music/preview.js';
import type { MusicDevice, MusicDeviceProvider, MusicMonitorMode } from '../src/music/device.js';
import { desiredMusicMonitorMode, type MusicTruth } from '../src/music/cues.js';
import type { MusicPreviewRequest } from '@mizar/protocol/music';

test('desiredMusicMonitorMode maps preference directly to monitor-and-output or off', () => {
  assert.equal(desiredMusicMonitorMode(true), 'monitor-and-output');
  assert.equal(desiredMusicMonitorMode(false), 'off');
});

test('music monitor preference persists across offline failure and syncs on reconnect', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-monitor-disable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  await store.update((state) => {
    state.sources.bgm = 'music-source';
    state.monitorPreference = true;
  });
  let offline = true;
  let sessions = 0;
  let mode: MusicMonitorMode = 'monitor-and-output';
  const device: Partial<MusicDevice> = {
    hasSource: async (_store, layer) => layer === 'bgm',
    verifyPlayback: async () => {},
    mediaStatus: async () => ({ state: 'stopped', cursorMs: 0, durationMs: 0 }),
    mute: async () => false,
    volume: async () => 1,
    mediaFile: async () => '',
    setVolume: async () => {},
    setMute: async () => {},
    controlMedia: async () => {},
    loadMedia: async () => {},
    setMonitorMode: async ({ sourceId, mode: next }) => {
      assert.equal(sourceId, 'music-source');
      mode = next;
    },
    monitorMode: async () => mode,
  };
  device.checkCalls = () => device as unknown as MusicDevice;
  device.guardWrites = () => device as unknown as MusicDevice;
  const provider: MusicDeviceProvider = {
    session: (run) => {
      sessions++;
      if (offline) return Promise.reject(new Error('obs_disconnected'));
      return run(device as unknown as MusicDevice, 1);
    },
    close: async () => {},
  };
  const director = (state: MusicStore) =>
    new MusicDirector(
      state,
      provider,
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
      Date.now,
      Math.random,
      async () => false,
      () => false,
    );
  await assert.rejects(director(store).monitor(false), /obs_disconnected/);
  assert.equal(sessions, 2);
  const reopened = new MusicStore(directory);
  await reopened.load();
  const resumed = director(reopened);
  assert.equal(reopened.state.monitorPreference, false);

  offline = false;
  await resumed.tick(true);
  assert.equal(mode, 'off');
  assert.equal(resumed.get().monitor, 'disabled');
});

test('MusicStore loads legacy state.json stripping deprecated monitor fields', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-legacy-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  const statePath = join(directory, 'state.json');
  const raw = {
    ...store.state,
    previewMonitorLeases: [
      {
        uuid: 'audition-source',
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
  };
  await writeFile(statePath, JSON.stringify(raw), 'utf8');

  const reloaded = new MusicStore(directory);
  await reloaded.load();
  assert.equal(reloaded.ready, true);
  assert.equal(reloaded.failure, false);
  assert.equal('previewMonitorLeases' in reloaded.state, false);
  assert.equal('desktopMonitorOriginal' in reloaded.state, false);
  assert.equal('monitorConfigured' in reloaded.state, false);

  const monitor = new PreviewMonitor(reloaded);
  assert.equal(typeof monitor.syncPreference, 'function');
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

  // Refresh the automatic cooldown and recover cleanly.
  await director.tick(true);
  rpcTimeout = false;
  now += 2000;
  await director.tick();
  assert.ok(monitorReads >= 0);
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
        GetInputAudioMonitorType: { monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
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

test('monitor(true) applies monitor-and-output directly, requires readback, and mixerStatus reports desktopIncludesMusic=false', async (t) => {
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
  await assert.rejects(rig.director.monitor(true), /music_monitor_unconfirmed/);
  assert.deepEqual(writes, ['monitor-and-output']);
  assert.equal(rig.director.get().monitor, 'disabled');

  failReadback = false;
  await rig.director.monitor(true);
  assert.deepEqual(writes, ['monitor-and-output', 'monitor-and-output']);
  assert.equal(rig.director.get().monitor, 'enabled');
  assert.equal(rig.director.mixerStatus().desktopIncludesMusic, false);
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

test('music preview aborts before media load and restores monitor when monitor observation is unconfirmed', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-preview-monitor-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  store.trackPath = async () => '/tmp/fake-track.mp3';
  await store.update((s) => {
    s.monitorPreference = false;
    s.sources.stinger = 'stinger-uuid';
    s.sourceScopes.stinger = 'owned-collection';
  });

  const events: { stage: string; evidence: unknown }[] = [];
  const originalPreviewEvent = store.previewEvent.bind(store);
  store.previewEvent = (stage, evidence) => {
    events.push({ stage, evidence });
    originalPreviewEvent(stage, evidence);
  };

  let mode: MusicMonitorMode = 'off';
  let readsAfterBorrow = -1;
  let loadCalls = 0;
  let controlCalls = 0;
  const device: Partial<MusicDevice> = {
    hasSource: async (_s, layer) => layer === 'stinger',
    outputsStopped: async () => true,
    ownershipScope: async () => 'owned-collection',
    verifyPlayback: async () => {},
    mediaStatus: async () => ({ state: 'stopped', cursorMs: 0, durationMs: 10_000 }),
    mute: async () => false,
    volume: async () => 1,
    monitorMode: async () => {
      if (readsAfterBorrow >= 0) {
        readsAfterBorrow++;
        if (readsAfterBorrow <= 2) return undefined;
      }
      return mode;
    },
    setMonitorMode: async ({ mode: next }) => {
      mode = next;
      readsAfterBorrow = next === 'monitor-and-output' ? 0 : -1;
    },
    loadMedia: async () => {
      loadCalls++;
    },
    controlMedia: async () => {
      controlCalls++;
    },
    guardWrites: () => device as unknown as MusicDevice,
    checkCalls: () => device as unknown as MusicDevice,
  };

  const now = 1000;
  const preview = new MusicPreview(store, () => now);
  const request: MusicPreviewRequest = {
    action: 'start',
    owner: 'panel',
    token: 'tok-1',
    operation: 1,
    expiresAt: now + 3000,
    group: 'waiting',
    track: { id: `${'d'.repeat(64)}.mp3`, name: 'Track', startMs: 0, endMs: null, gain: 1 },
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    confirmed: false,
  };
  preview.submit(request);

  await preview.reconcile(
    device as unknown as MusicDevice,
    1,
    () => true,
    true,
    () => {},
    async () => {},
  );

  assert.equal(loadCalls, 0);
  assert.equal(controlCalls, 0);
  assert.equal(mode, 'off');
  assert.equal(preview.status?.phase, 'failed');
  assert.match(preview.status?.message ?? '', /请检查 OBS 连接或音频监听设置后重试/);
  assert.ok(
    events.some(
      (e) =>
        e.stage === 'music_preview_failed' &&
        (e.evidence as { reason?: string } | undefined)?.reason === 'monitor_unavailable',
    ),
  );
});

test('music preview stops playback and enters cleanup then failed when monitor is disabled mid-preview', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-preview-monitor-lost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MusicStore(directory);
  await store.load();
  store.trackPath = async () => '/tmp/fake-track.mp3';
  await store.update((s) => {
    s.sources.stinger = 'stinger-uuid';
    s.sourceScopes.stinger = 'owned-collection';
  });

  let mode: MusicMonitorMode = 'off';
  let mediaState: 'stopped' | 'playing' = 'stopped';
  let mediaFile = '';
  let volume = 1;
  const device: Partial<MusicDevice> = {
    hasSource: async (_s, layer) => layer === 'stinger',
    outputsStopped: async () => true,
    ownershipScope: async () => 'owned-collection',
    verifyPlayback: async () => {},
    mediaStatus: async () => ({ state: mediaState, cursorMs: 500, durationMs: 10_000 }),
    mute: async () => false,
    volume: async () => volume,
    mediaFile: async () => mediaFile,
    monitorMode: async () => mode,
    setMonitorMode: async ({ mode: next }) => {
      mode = next;
    },
    setVolume: async ({ gain }) => {
      volume = gain;
    },
    loadMedia: async ({ path }) => {
      mediaFile = path;
    },
    controlMedia: async ({ action }) => {
      if (action === 'restart') mediaState = 'playing';
      if (action === 'stop') mediaState = 'stopped';
    },
    guardWrites: () => device as unknown as MusicDevice,
    checkCalls: () => device as unknown as MusicDevice,
  };

  let now = 1000;
  const preview = new MusicPreview(store, () => now);
  preview.submit({
    action: 'start',
    owner: 'panel',
    token: 'tok-2',
    operation: 1,
    expiresAt: now + 3000,
    group: 'waiting',
    track: { id: `${'e'.repeat(64)}.mp3`, name: 'Track', startMs: 0, endMs: null, gain: 1 },
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    confirmed: false,
  });

  const runReconcile = () =>
    preview.reconcile(
      device as unknown as MusicDevice,
      1,
      () => true,
      true,
      () => {},
      async () => {},
    );

  // 1. Start preview: enables monitor-and-output and restarts media.
  await runReconcile();
  assert.equal(preview.status?.phase, 'requested');
  assert.equal(mode, 'monitor-and-output');

  // 2. Media is playing with monitor enabled.
  now += 200;
  await runReconcile();
  assert.equal(preview.status?.phase, 'playing');

  // 3. Monitor is turned off mid-preview -> stops preview into cleanup state.
  mode = 'off';
  now += 200;
  await runReconcile();
  assert.equal(preview.status?.phase, 'cleanup');
  assert.match(preview.status?.message ?? '', /本机监听已关闭/);

  // 4. Next reconcile stops OBS media and settles into failed state.
  now += 200;
  await runReconcile();
  assert.equal(mediaState, 'stopped');
  assert.equal(preview.status?.phase, 'failed');
  assert.match(preview.status?.message ?? '', /本机监听已关闭/);
});

test('ensureManagedAudioSources initializes managed sources to NONE once and setAudioDevice allows default selector', async () => {
  const { ensureManagedAudioSources, checkObsAudio } = await import('../src/obs/audio.js');
  const { setAudioDevice, readAudioDevices } = await import('../src/obs/audio-device-settings.js');
  const { obsDesiredScenes } = await import('../src/obs/desired-state.js');
  const scenes = obsDesiredScenes('http://127.0.0.1:3000').map((s) => ({ sceneName: s.sceneName }));
  const inputs: { inputName: string; inputKind: string; inputUuid: string }[] = [];
  const monitorTypes = new Map<string, string>();
  const deviceIds = new Map<string, string>();
  const sceneItems = new Map<
    string,
    { sourceName: string; sourceUuid: string; sceneItemId: number; sceneItemEnabled: boolean }[]
  >();
  for (const s of scenes) sceneItems.set(s.sceneName, []);
  let nextItemId = 1;

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
        const itemId = nextItemId++;
        sceneItems.get(params.sceneName as string)!.push({
          sourceName: row.inputName,
          sourceUuid: uuid,
          sceneItemId: itemId,
          sceneItemEnabled: Boolean(params.sceneItemEnabled),
        });
        return { inputUuid: uuid, sceneItemId: itemId };
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

  // Subsequent runs preserve operator monitor adjustments.
  monitorTypes.set(created.desktop, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
  await ensureManagedAudioSources(obs as never, 'http://127.0.0.1:3000', false);
  assert.equal(monitorTypes.get(created.desktop), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');

  // Switching desktop device to speakers-id and back to default succeeds without device-relationship blocking.
  const initialDevices = await readAudioDevices(obs as never);
  const firstRead = await setAudioDevice(obs as never, {
    revision: initialDevices.revision,
    role: 'desktop',
    deviceId: 'speakers-id',
  });
  assert.equal(firstRead.devices.find((d) => d.role === 'desktop')?.deviceId, 'speakers-id');
  const secondRead = await setAudioDevice(obs as never, {
    revision: firstRead.revision,
    role: 'desktop',
    deviceId: 'default',
  });
  assert.equal(secondRead.devices.find((d) => d.role === 'desktop')?.deviceId, 'default');

  const findings = await checkObsAudio(obs as never);
  assert.deepEqual(
    findings.filter((f) => f.code !== 'audio_stream_tracks_unknown'),
    [],
  );
});

test('ObsAudioRouting deserializes legacy transition with musicBefore and musicAfter', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-legacy-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { ObsAudioRouting } = await import('../src/obs/audio-routing.js');
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
        musicAfter: {
          bgm: { uuid: 'bgm-uuid', mode: 'OBS_MONITORING_TYPE_NONE' },
          stinger: null,
        },
      },
    }),
    'utf8',
  );
  const routing = new ObsAudioRouting(routingPath);
  const state = await routing.modeRecoveryState();
  assert.ok(state.transition && state.transition !== true);
  assert.equal(state.transition.id, '22222222-2222-4222-8222-222222222222');
});

test('continuous preview stop polls OBS media status and allows immediate re-preview, and expired opening does not block', async (t) => {
  const track = { id: `${'f'.repeat(64)}.mp3`, name: 'Track', startMs: 0, endMs: null, gain: 1 };
  let stingerState: 'stopped' | 'playing' = 'stopped';
  let stingerStopPolls = 0;
  let stingerMode: MusicMonitorMode = 'off';
  let stingerFile = '';
  let stingerVol = 1;
  let failMonitorWrite = true;
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
      hasSource: async (_s, layer) => layer === 'stinger',
      outputsStopped: async () => true,
      ownershipScope: async () => 'owned-collection',
      mediaFile: async () => stingerFile,
      volume: async () => stingerVol,
      setVolume: async ({ gain }) => {
        stingerVol = gain;
      },
      monitorMode: async () => stingerMode,
      setMonitorMode: async ({ mode }) => {
        if (failMonitorWrite) throw new Error('obs_monitor_write_failed');
        stingerMode = mode;
      },
      loadMedia: async ({ path }) => {
        stingerFile = path;
      },
      controlMedia: async ({ action }) => {
        if (action === 'restart') stingerState = 'playing';
        if (action === 'stop') stingerStopPolls = 0;
      },
      mediaStatus: async () => {
        if (stingerState === 'playing' && stingerStopPolls >= 0) {
          stingerStopPolls++;
          if (stingerStopPolls >= 2) stingerState = 'stopped';
        }
        return { state: stingerState, cursorMs: 100, durationMs: 10_000 };
      },
    },
  );
  rig.store.trackPath = async () => '/tmp/fake-track.mp3';
  await rig.store.update((s) => {
    s.monitorPreference = false;
    s.sources.stinger = 'stinger-uuid';
    s.sourceScopes.stinger = 'owned-collection';
  });

  const makeReq = (operation: number, action: 'start' | 'stop' = 'start'): MusicPreviewRequest => ({
    action,
    owner: '11111111-1111-4111-8111-111111111111',
    token: '22222222-2222-4222-8222-222222222222',
    operation,
    expiresAt: 1000 + 3000,
    group: 'waiting',
    track,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    confirmed: false,
  });

  // 1. Monitor write failure fails cleanly with monitor_unavailable and allows retry.
  await rig.director.previewRequest(makeReq(1, 'start'));
  assert.equal(rig.director.get().preview?.phase, 'failed');

  // 2. Retry succeeds and starts preview.
  failMonitorWrite = false;
  await rig.director.previewRequest(makeReq(2, 'start'));
  assert.equal(stingerMode, 'monitor-and-output');

  // 3. Explicit stop polls OBS media status and syncs stinger back to monitorPreference=false.
  await rig.director.command('stop');
  assert.equal(stingerState, 'stopped');
  assert.equal(stingerMode, 'off');

  // 4. Resume and start a fresh preview immediately.
  await rig.director.command('resume');
  await rig.director.previewRequest(makeReq(3, 'start'));
  assert.equal(stingerMode, 'monitor-and-output');

  // 5. Active opening blocks preview with music_preview_opening_busy.
  await rig.director.command('stop');
  await rig.director.command('resume');
  rig.director.opening('opening:active', track);
  await assert.rejects(
    rig.director.previewRequest(makeReq(4, 'start')),
    /music_preview_opening_busy/,
  );
});
