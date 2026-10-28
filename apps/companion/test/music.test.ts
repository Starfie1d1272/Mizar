import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { MUSIC_GROUPS, type MusicPreviewRequest } from '@mizar/protocol/music';
import type { ObsRpc } from '../src/obs/reconcile.js';
import { MusicStore } from '../src/music/store.js';
import { MusicDirector } from '../src/music/director.js';
import { ownedMusicInput } from '../src/music/obs-provider.js';
import type { MusicTruth } from '../src/music/cues.js';
import { musicWav, MediaObs } from './music-fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function rig() {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-music-'));
  directories.push(directory);
  const store = new MusicStore(directory);
  await store.load();
  const tracks = [
    await store.add('合成一.wav', musicWav()),
    await store.add('合成二.wav', musicWav(1)),
  ];
  const config = structuredClone(store.state.config);
  for (const group of MUSIC_GROUPS)
    config.groups[group] = {
      ...config.groups[group],
      tracks: group === 'waiting' || group === 'technical' ? tracks : [tracks[0]!],
      fadeInMs: 0,
      fadeOutMs: 0,
    };
  await store.configure(config);
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const snap = programSnapshotSchema.parse(artifact.fixtures['real-live-rich']!.snapshot);
  const program = structuredClone({ ...snap.payload, cursor: snap.cursor });
  program.status = { context: 'fresh', telemetry: 'fresh', identity: 'matched' };
  program.series!.bindingState = 'bound';
  program.map.phase = 'warmup';
  program.clock = null;
  const truth: Omit<MusicTruth, 'program'> & { program: typeof program } = {
    program,
    active: 'waiting',
    production: true,
  };
  const obs = new MediaObs();
  let time = 0;
  const provider = {
    session: <T>(run: (rpc: ObsRpc, epoch: number) => Promise<T>) => run(obs, 1),
    close: () => Promise.resolve(),
  };
  const director = new MusicDirector(
    store,
    provider,
    () => truth,
    () => time,
    () => 0,
  );
  return {
    store,
    obs,
    truth,
    director,
    tracks,
    directory,
    provider,
    now: () => time,
    elapse: (ms: number) => {
      time += ms;
    },
    step: async (ms = 300) => {
      time += ms;
      await director.tick();
    },
  };
}
it('loads legacy music state with independent master defaults and preserves it on configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-music-legacy-'));
  directories.push(directory);
  const original = new MusicStore(directory);
  await original.load();
  const legacy = structuredClone(original.state) as Partial<typeof original.state>;
  delete legacy.master;
  delete legacy.muted;
  await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
  const store = new MusicStore(directory);
  await store.load();
  expect(store.state.master).toBe(1);
  expect(store.state.muted).toBe(false);
  await store.update((state) => {
    state.master = 0.3;
    state.muted = true;
  });
  await store.configure(structuredClone(store.state.config));
  const reloaded = new MusicStore(directory);
  await reloaded.load();
  expect(reloaded.state.master).toBe(0.3);
  expect(reloaded.state.muted).toBe(true);
});
it('assigns stable distinct entry identities to duplicate legacy tracks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-music-entries-'));
  directories.push(directory);
  const original = new MusicStore(directory);
  await original.load();
  const track = await original.add('duplicate.wav', musicWav());
  const legacy = structuredClone(original.state);
  legacy.config.groups.waiting.tracks = [track, { ...track }, { ...track, startMs: 10 }];
  legacy.config.groups.technical.tracks = [{ ...track }];
  await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
  const store = new MusicStore(directory);
  await store.load();
  const ids = [
    ...store.state.config.groups.waiting.tracks,
    ...store.state.config.groups.technical.tracks,
  ].map((item) => item.entryId);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(4);
  const again = new MusicStore(directory);
  await again.load();
  expect(
    [
      ...again.state.config.groups.waiting.tracks,
      ...again.state.config.groups.technical.tracks,
    ].map((item) => item.entryId),
  ).toEqual(ids);
  await again.configure(structuredClone(again.state.config));
  expect(again.state.config.groups.waiting.tracks.map((item) => item.entryId)).toEqual(
    ids.slice(0, 3),
  );
});
it('migrates a legacy playback snapshot to the matching entry without changing its level', async () => {
  const r = await rig();
  await r.step();
  const legacy = structuredClone(r.store.state);
  for (const group of MUSIC_GROUPS)
    for (const track of legacy.config.groups[group].tracks) delete track.entryId;
  delete legacy.bgm!.track.entryId;
  delete legacy.bgm!.configRevision;
  await writeFile(join(r.directory, 'state.json'), JSON.stringify(legacy));
  const restored = new MusicStore(r.directory);
  await restored.load();
  expect(restored.state.bgm?.track.entryId).toBe(
    restored.state.config.groups.waiting.tracks[0]?.entryId,
  );
  expect(restored.state.bgm?.configRevision).toBe(restored.state.configRevision);
  expect(restored.state.config.groups.waiting.volume).toBe(0.5);
});
it('composes the current entry gain with master and mutes without restarting playback', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.tracks[0]!.gain = 0.4;
  config.groups.technical.tracks[0]!.gain = 0.8;
  await r.store.configure(config);
  await r.store.update((state) => {
    state.master = 0.5;
  });
  await r.step();
  expect(r.obs.bgm().volume).toBeCloseTo(0.2);
  const starts = r.obs.restarts();
  await r.store.update((state) => {
    state.muted = true;
  });
  await r.step();
  expect(r.obs.bgm().volume).toBe(0);
  expect(r.obs.restarts()).toBe(starts);
  await r.store.update((state) => {
    state.muted = false;
    state.master = 0.25;
  });
  await r.step();
  expect(r.obs.bgm().volume).toBeCloseTo(0.1);
  expect(r.obs.restarts()).toBe(starts);
});
it('keeps the existing OBS hold when music mute is cleared', async () => {
  const r = await rig();
  await r.step();
  r.obs.bgm().volume = 0.17;
  await r.step();
  expect(r.director.get().held).toBe(true);
  const starts = r.obs.restarts();
  expect(await r.director.setMixer(0.3, true)).toBe(false);
  expect(await r.director.setMixer(undefined, false)).toBe(false);
  expect(r.director.get().held).toBe(true);
  expect(r.obs.bgm().volume).toBe(0.17);
  expect(r.obs.restarts()).toBe(starts);
});
it('applies master changes during fade-in without restarting', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeInMs = 1000;
  config.groups.waiting.tracks[0]!.gain = 0.8;
  await r.store.configure(config);
  await r.step();
  const starts = r.obs.restarts();
  await r.step(500);
  expect(r.obs.bgm().volume).toBeCloseTo(0.4);
  await r.store.update((state) => {
    state.master = 0.5;
  });
  await r.step(100);
  expect(r.obs.bgm().volume).toBeCloseTo(0.24);
  expect(r.obs.restarts()).toBe(starts);
});
it('advances duplicate files by entry identity in automatic and manual playback', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.tracks = [
    { ...r.tracks[0]!, gain: 0.2 },
    { ...r.tracks[0]!, gain: 0.8 },
    { ...r.tracks[1]!, gain: 0.4 },
  ];
  await r.store.configure(config);
  const entries = r.store.state.config.groups.waiting.tracks;
  await r.step();
  expect(r.store.state.bgm?.track.entryId).toBe(entries[0]!.entryId);
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  expect(r.store.state.bgm?.track.entryId).toBe(entries[1]!.entryId);
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  expect(r.store.state.bgm?.track.entryId).toBe(entries[2]!.entryId);
  await expect(r.director.manualPlay('waiting', entries[0]!.id)).rejects.toThrow(
    'music_track_invalid',
  );
  await r.director.manualPlay('waiting', undefined, entries[0]!.entryId);
  await r.director.command('next');
  expect(r.store.state.bgm?.track.entryId).toBe(entries[1]!.entryId);
});
it('keeps pre-game waiting music across fresh menu GSI and BP, but stops for stale data and live play', async () => {
  const r = await rig();
  r.truth.program.map.name = null;
  r.truth.program.map.phase = null;
  r.truth.program.series!.bindingState = 'unbound';
  r.truth.program.status.telemetry = 'awaiting';
  await r.step();
  expect(r.director.get().bgm?.group).toBe('waiting');
  const starts = r.obs.restarts();
  r.truth.program.status.telemetry = 'fresh';
  r.truth.program.status.identity = 'resolving';
  await r.step();
  r.truth.active = 'bp';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.obs.restarts()).toBe(starts);
  r.truth.program.status.telemetry = 'stale';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.truth.program.status.telemetry = 'fresh';
  r.truth.program.status.identity = 'matched';
  r.truth.program.series!.bindingState = 'bound';
  r.truth.program.map.name = 'de_mirage';
  r.truth.program.map.phase = 'live';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  await r.director.close();
});
it('shares waiting across pictures and maps, loops without immediate repeats, then respects a persisted manual stop', async () => {
  const r = await rig();
  await r.step();
  expect(r.obs.restarts()).toBe(1);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.obs.bgm().muted).toBe(false);
  for (const active of ['bp', 'waiting', 'intermap'] as const) {
    r.truth.active = active;
    await r.step();
  }
  r.truth.program.cursor.mapEpoch++;
  await r.step();
  expect(r.obs.restarts()).toBe(1);
  const before = r.obs.bgm().file;
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  expect(r.obs.bgm().file).not.toBe(before);
  await r.director.command('stop');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  const restored = new MusicStore(r.directory);
  await restored.load();
  expect(restored.state.held).toBe(true);
  const after = new MusicDirector(restored, r.provider, () => r.truth);
  await after.tick();
  expect(r.obs.restarts()).toBe(2);
  await after.command('resume');
  expect(r.obs.restarts()).toBe(3);
  const shuffled = structuredClone(restored.state.config);
  shuffled.groups.waiting.order = 'shuffle';
  await restored.configure(shuffled);
  const prior = r.obs.bgm().file;
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  await after.tick();
  expect(r.obs.bgm().file).not.toBe(prior);
  expect(JSON.stringify(after.get())).not.toContain(r.directory);
});
it('suppresses music video on reconnect and before enabling new scene attachments without touching foreign items', async () => {
  const r = await rig();
  await r.step();
  const sourceUuid = r.store.state.sources.bgm!;
  const name = [...r.obs.inputs.keys()][0]!;
  const calls: { type: string; data: Record<string, unknown> }[] = [];
  let existing = true;
  const rpc: ObsRpc = {
    async call(type, data = {}) {
      calls.push({ type, data });
      if (type === 'GetSceneItemList')
        return {
          sceneItems: [
            { sourceName: 'Game Capture', sourceUuid: 'game', sceneItemId: 10 },
            ...(existing ? [{ sourceName: name, sourceUuid, sceneItemId: 20 }] : []),
          ],
        };
      if (type === 'CreateSceneItem') return { sceneItemId: 30 };
      if (type === 'SetSceneItemTransform' || type === 'SetSceneItemEnabled') return {};
      return r.obs.call(type, data);
    },
  };
  await ownedMusicInput(rpc, r.store, 'bgm', true, () => true);
  expect(
    calls.filter((c) => c.type === 'SetSceneItemTransform').map((c) => c.data.sceneItemId),
  ).toEqual([20]);
  expect(calls.some((c) => c.type === 'SetSceneItemEnabled')).toBe(false);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  calls.length = 0;
  existing = false;
  await ownedMusicInput(rpc, r.store, 'bgm', true, () => true);
  expect(calls.filter((c) => c.type.startsWith('Set') || c.type === 'CreateSceneItem')).toEqual([
    {
      type: 'CreateSceneItem',
      data: { sceneName: 'Mizar · 赛前等待', sourceUuid, sceneItemEnabled: false },
    },
    {
      type: 'SetSceneItemTransform',
      data: {
        sceneName: 'Mizar · 赛前等待',
        sceneItemId: 30,
        sceneItemTransform: { boundsType: 'OBS_BOUNDS_NONE', scaleX: 0, scaleY: 0 },
      },
    },
    {
      type: 'SetSceneItemEnabled',
      data: { sceneName: 'Mizar · 赛前等待', sceneItemId: 30, sceneItemEnabled: true },
    },
  ]);
  expect(r.obs.restarts()).toBe(1);
});
it('distinguishes tactical / technical pauses, preserves the same pause across relabelling and reconnect, and gives halftime precedence', async () => {
  const r = await rig();
  r.truth.active = 'gameplay';
  r.truth.program.map.phase = 'live';
  r.truth.program.map.score = { ct: 2, t: 3 };
  r.truth.program.clock = { phase: 'timeout_ct', endsInSeconds: 46 };
  await r.step();
  expect(r.director.get().bgm?.group).toBe('tactical');
  const id = r.store.state.pause!.id;
  r.truth.program.clock.phase = 'paused';
  await r.step();
  expect(r.store.state.pause!.id).toBe(id);
  expect(r.obs.restarts()).toBe(1);
  r.obs.disconnected = true;
  await r.step();
  r.obs.disconnected = false;
  await r.step();
  expect(r.obs.restarts()).toBe(1);
  r.truth.program.clock.phase = 'freezetime';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.truth.program.clock.phase = 'paused';
  await r.step();
  expect(r.director.get().bgm?.group).toBe('technical');
  expect(r.store.state.pause!.id).not.toBe(id);
  r.truth.program.map.score = { ct: 6, t: 6 };
  r.truth.program.map.roundNumber = 12;
  r.truth.active = 'halftime';
  await r.step();
  expect(r.director.get().bgm?.group).toBe('halftime');
  r.truth.program.clock = { phase: 'freezetime', endsInSeconds: 20 };
  await r.step();
  expect(r.director.get().bgm?.group).toBe('halftime');
  r.truth.program.clock.endsInSeconds = 4;
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
});
it('finishes map victory naturally into waiting, preempts it for live play, and only plays final series victory once', async () => {
  const r = await rig();
  r.truth.program.map.phase = 'gameover';
  r.truth.program.series!.status = 'live';
  r.truth.active = 'map_result';
  await r.step();
  expect(r.director.get().bgm).toBeNull();
  const result = r.truth.program.series!.maps.find(
    (m) => m.mapOrder === r.truth.program.series!.currentMapOrder,
  )!;
  result.status = 'completed';
  result.finalScore = { a: 13, b: 9 };
  await r.step();
  expect(r.director.get().bgm?.group).toBe('mapVictory');
  r.truth.active = 'intermap';
  await r.step();
  expect(r.obs.restarts()).toBe(1);
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  await r.step();
  expect(r.director.get().bgm?.group).toBe('waiting');
  const waitingStarts = r.obs.restarts();
  for (const active of ['waiting', 'bp', 'intermap'] as const) {
    r.truth.active = active;
    await r.step();
    expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  }
  expect(r.obs.restarts()).toBe(waitingStarts);
  r.truth.program.map.phase = 'live';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.truth.program.map.phase = 'gameover';
  r.truth.program.series!.status = 'completed';
  r.truth.active = 'map_result';
  await r.step();
  expect(r.director.get().bgm?.group).toBe('matchVictory');
  const starts = r.obs.restarts();
  r.truth.active = 'match_result';
  await r.step();
  expect(r.obs.restarts()).toBe(starts);
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  await r.step();
  expect(r.director.get().bgm).toBeNull();
  expect(r.obs.restarts()).toBe(starts);
});
it('layers only actual opening starts and never catches up an expired or consumed event', async () => {
  const r = await rig();
  await r.store.update((state) => {
    state.consumed = ['previous', 'previous'];
  });
  await r.step();
  r.director.opening('take-1');
  await r.step();
  expect(r.obs.inputs.size).toBe(2);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.obs.restarts()).toBe(2);
  r.director.opening('take-1');
  await r.step();
  expect(r.obs.restarts()).toBe(2);
  const stinger = [...r.obs.inputs].find(([name]) => name.includes('Stinger'))![1];
  stinger.state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  await r.step();
  expect(r.store.state.consumed).toEqual(['previous', 'take-1']);
  r.director.opening('take-expired');
  await r.step(2000);
  expect(r.obs.restarts()).toBe(2);
  const restored = new MusicStore(r.directory);
  await restored.load();
  const next = new MusicDirector(restored, r.provider, () => r.truth);
  await next.tick();
  expect(r.obs.restarts()).toBe(2);
  r.truth.program.status.telemetry = 'stale';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(stinger.state).toBe('OBS_MEDIA_STATE_ENDED');
});
it('keeps OBS manual stop / mute and cancels a late start when formal play resumes', async () => {
  const r = await rig();
  await r.step();
  r.obs.bgm().muted = true;
  await r.step();
  expect(r.store.state.held).toBe(true);
  await r.step();
  const starts = r.obs.restarts();
  r.obs.bgm().muted = false;
  await r.step();
  expect(r.obs.restarts()).toBe(starts);
  await r.director.command('resume');
  expect(r.obs.restarts()).toBe(starts + 1);
  r.obs.bgm().volume = 0.2;
  await r.step();
  expect(r.store.state.held).toBe(true);
  await r.director.command('resume');
  await r.step();
  expect(r.director.get().held).toBe(false);
  expect(r.obs.bgm().volume).toBe(0.5);
  r.obs.bgm().state = 'OBS_MEDIA_STATE_STOPPED';
  await r.step();
  expect(r.store.state.held).toBe(true);
  await r.director.command('resume');
  await r.director.command('stop');
  await r.store.hold(false);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  r.obs.intercept = async (type) => {
    if (type === 'GetInputSettings') {
      reached();
      await blocked;
    }
  };
  const task = r.step();
  await waiting;
  r.truth.program.map.phase = 'live';
  await r.director.tick();
  release();
  await task;
  r.obs.intercept = undefined;
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  const disk = await readFile(join(r.directory, 'state.json'), 'utf8');
  expect(disk).not.toContain(r.directory);
});
it('skips invalid tracks, isolates an empty group, and refuses a source whose UUID was replaced', async () => {
  const r = await rig();
  await r.step();
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ERROR';
  await r.step();
  await r.step();
  expect(r.obs.restarts()).toBe(2);
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ERROR';
  await r.step();
  await r.step();
  expect(r.obs.restarts()).toBe(2);
  r.truth.program.map.phase = 'live';
  r.truth.program.clock = { phase: 'timeout_t', endsInSeconds: 70 };
  r.truth.program.map.score = { ct: 1, t: 0 };
  const config = structuredClone(r.store.state.config);
  config.groups.tactical.tracks = [];
  await r.store.configure(config);
  await r.step();
  expect(r.obs.restarts()).toBe(2);
  const ownName = [...r.obs.inputs.keys()][0]!;
  r.obs.inputs.delete(ownName);
  r.truth.program.map.phase = 'warmup';
  r.truth.program.clock = null;
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  r.obs.bgm().uuid = 'foreign';
  r.truth.program.map.phase = 'warmup';
  r.truth.program.clock = null;
  const mutations = r.obs.calls.length;
  await r.step();
  expect(r.obs.calls.slice(mutations).filter((c) => /^Set|Trigger/.test(c.type))).toHaveLength(0);
  expect(r.director.get().connection).toBe('unavailable');
});
it('uses the real obs-websocket client to reconcile owned media after a connection is replaced', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: websocket } = await import('@fastify/websocket');
  const { ObsConfigStore } = await import('../src/obs/config.js');
  const { ObsMusicProvider } = await import('../src/music/obs-provider.js');
  const r = await rig(),
    server = Fastify();
  let connections = 0,
    failRpc = false;
  const diagnostics: unknown[] = [];
  await server.register(websocket);
  server.get('/', { websocket: true }, (socket) => {
    connections++;
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    const handle = async (data: Buffer) => {
      const request = JSON.parse(data.toString()) as {
        op: number;
        d: { requestType: string; requestId: string; requestData: Record<string, unknown> };
      };
      if (request.op === 1) socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      if (request.op === 6 && failRpc) {
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: request.d.requestType,
              requestId: request.d.requestId,
              requestStatus: {
                result: false,
                code: 500,
                comment: 'synthetic RPC rejection CANARY-MUSIC-PASSWORD',
              },
            },
          }),
        );
        return;
      }
      if (request.op === 6)
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: request.d.requestType,
              requestId: request.d.requestId,
              requestStatus: { result: true, code: 100 },
              responseData: await r.obs.call(request.d.requestType, request.d.requestData),
            },
          }),
        );
    };
    socket.on('message', (data) => {
      if (Buffer.isBuffer(data)) void handle(data).catch(() => socket.close());
    });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('address unavailable');
  const config = new ObsConfigStore(join(r.directory, 'obs.json'));
  await config.save({
    host: '127.0.0.1',
    port: address.port,
    password: 'CANARY-MUSIC-PASSWORD',
    executablePath: null,
  });
  const provider = new ObsMusicProvider(config, (stage, evidence) =>
      diagnostics.push({ stage, evidence }),
    ),
    director = new MusicDirector(r.store, provider, () => r.truth);
  try {
    await director.tick();
    expect(r.obs.restarts()).toBe(1);
    await provider.session(() => Promise.resolve());
    await provider.session(() => Promise.resolve());
    expect(connections).toBe(1);
    await provider.close();
    await director.tick();
    expect(r.obs.restarts()).toBe(1);
    const restored = new MusicStore(r.directory);
    await restored.load();
    const newDirector = new MusicDirector(restored, provider, () => r.truth);
    await newDirector.tick();
    expect(r.obs.restarts()).toBe(1);
    await newDirector.command('stop');
    expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
    expect(restored.state.held).toBe(true);
    failRpc = true;
    await expect(provider.session((rpc) => rpc.call('GetVersion'))).rejects.toThrow(
      'music_obs_unavailable',
    );
    expect(JSON.stringify(diagnostics)).toContain('synthetic RPC rejection');
    expect(JSON.stringify(diagnostics)).toContain('GetVersion');
    expect(JSON.stringify(diagnostics)).not.toContain('CANARY-MUSIC-PASSWORD');
  } finally {
    await provider.close();
    await server.close();
  }
});
it('fades incrementally without blocking an urgent stop and restores only system-suspended media at its cursor', async () => {
  const r = await rig(),
    config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeInMs = 1000;
  config.groups.waiting.fadeOutMs = 1000;
  await r.store.configure(config);
  await r.step();
  expect(r.obs.bgm().volume).toBe(0);
  await r.step(500);
  expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  await r.step(500);
  expect(r.obs.bgm().volume).toBeCloseTo(0.5);
  r.obs.bgm().cursor = 2400;
  r.truth.program.status.telemetry = 'stale';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.store.state.held).toBe(false);
  r.truth.program.status.telemetry = 'fresh';
  await r.step();
  expect(r.obs.bgm().cursor).toBe(2400);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  r.truth.program.map.phase = 'live';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.truth.program.status.telemetry = 'stale';
  r.truth.program.clock = null;
  await r.step();
  expect(r.store.state.pause).toBeNull();
  r.truth.program.map.phase = 'warmup';
  r.truth.program.status.telemetry = 'fresh';
  await r.step();
  const persistHold = r.store.hold.bind(r.store);
  r.store.hold = () => Promise.reject(new Error('disk unavailable'));
  await expect(r.director.command('stop')).rejects.toThrow('music_hold_persistence_failed');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.director.get().held).toBe(true);
  r.store.hold = persistHold;
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
});

it('waits for OBS media readiness before restoring a muted track cursor and fade', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeInMs = 1000;
  await r.store.configure(config);
  await r.step();
  await r.step(1000);
  r.obs.bgm().cursor = 2400;
  r.obs.bgm().muted = true;
  await r.step();
  expect(r.store.state.held).toBe(true);
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.obs.restartOpeningReads = 2;
  await r.director.command('resume');
  expect(r.obs.restarts()).toBe(2);
  expect(r.obs.bgm().cursor).toBe(2400);
  expect(r.store.state.held).toBe(false);
  await r.step(1000);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.obs.bgm().volume).toBeCloseTo(0.5);
  expect(r.store.state.held).toBe(false);
});

it('waits through the previous ended state without restarting a looping track repeatedly', async () => {
  const r = await rig();
  await r.step();
  r.obs.bgm().state = 'OBS_MEDIA_STATE_ENDED';
  r.obs.restartOpeningReads = 2;
  r.obs.restartState = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.step();
  expect(r.obs.restarts()).toBe(2);
  expect(r.store.state.held).toBe(false);
});

it('cancels cursor restoration when a newer stop arrives while OBS is opening media', async () => {
  const r = await rig();
  await r.step();
  r.obs.bgm().cursor = 2400;
  r.obs.bgm().muted = true;
  await r.step();
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.obs.restartOpeningReads = 2;
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  r.obs.intercept = async (type) => {
    if (type === 'GetMediaInputStatus' && r.obs.bgm().state === 'OBS_MEDIA_STATE_OPENING') {
      reached();
      await blocked;
    }
  };
  const resume = r.director.command('resume');
  await reading;
  await r.director.command('stop');
  release();
  await resume;
  r.obs.intercept = undefined;
  await r.step();
  expect(r.store.state.held).toBe(true);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.calls.filter((c) => c.type === 'SetMediaInputCursor')).toHaveLength(0);
});

const obsManualControls = [
  {
    name: 'stop',
    apply: (input: ReturnType<MediaObs['bgm']>) => {
      input.state = 'OBS_MEDIA_STATE_STOPPED';
    },
  },
  {
    name: 'pause',
    apply: (input: ReturnType<MediaObs['bgm']>) => {
      input.state = 'OBS_MEDIA_STATE_PAUSED';
    },
  },
  {
    name: 'mute',
    apply: (input: ReturnType<MediaObs['bgm']>) => {
      input.muted = true;
    },
  },
  {
    name: 'volume',
    apply: (input: ReturnType<MediaObs['bgm']>) => {
      input.volume = 0.2;
    },
  },
];
it('observes OBS manual control before replacing waiting with a tactical cue', async () => {
  for (const layer of ['bgm', 'stinger'] as const)
    for (const control of obsManualControls) {
      const r = await rig();
      await r.step();
      if (layer === 'stinger') {
        r.director.opening('take-manual');
        await r.step();
      }
      const input =
        layer === 'bgm'
          ? r.obs.bgm()
          : [...r.obs.inputs].find(([name]) => name.includes('Stinger'))![1];
      control.apply(input);
      const label = `${layer}:${control.name}`,
        starts = r.obs.restarts();
      r.truth.active = 'gameplay';
      r.truth.program.map.phase = 'live';
      r.truth.program.map.score = { ct: 2, t: 3 };
      r.truth.program.clock = { phase: 'timeout_ct', endsInSeconds: 44 };
      await r.step();
      expect(r.director.get().held, label).toBe(true);
      expect(r.store.state.held, label).toBe(true);
      expect(r.obs.restarts(), label).toBe(starts);
      await r.step();
      for (const source of r.obs.inputs.values())
        expect(source.state, label).toBe('OBS_MEDIA_STATE_STOPPED');
      await r.director.command('resume');
      expect(r.director.get().held, label).toBe(false);
      expect(r.director.get().bgm?.group, label).toBe('tactical');
      expect(r.obs.restarts(), label).toBe(starts + 1);
    }
});
it('observes OBS manual control before stale telemetry can record a system suspension', async () => {
  for (const layer of ['bgm', 'stinger'] as const)
    for (const control of obsManualControls) {
      const r = await rig();
      await r.step();
      if (layer === 'stinger') {
        r.director.opening('take-manual');
        await r.step();
      }
      const input =
        layer === 'bgm'
          ? r.obs.bgm()
          : [...r.obs.inputs].find(([name]) => name.includes('Stinger'))![1];
      control.apply(input);
      const label = `${layer}:${control.name}`,
        starts = r.obs.restarts();
      r.truth.program.status.telemetry = 'stale';
      await r.step();
      expect(r.director.get().held, label).toBe(true);
      r.truth.program.status.telemetry = 'fresh';
      await r.step();
      expect(r.obs.restarts(), label).toBe(starts);
      const restored = new MusicStore(r.directory);
      await restored.load();
      expect(restored.state.held, label).toBe(true);
      const next = new MusicDirector(restored, r.provider, () => r.truth);
      await next.tick();
      expect(r.obs.restarts(), label).toBe(starts);
      for (const source of r.obs.inputs.values())
        expect(source.state, label).toBe('OBS_MEDIA_STATE_STOPPED');
    }
});
it('cancels pending OBS unmute permission when a newer manual stop supersedes resume', async () => {
  const r = await rig();
  await r.step();
  await r.director.command('stop');
  r.obs.bgm().muted = true;
  const starts = r.obs.restarts();
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  r.obs.intercept = async (type) => {
    if (type === 'GetInputSettings') {
      reached();
      await blocked;
    }
  };
  const resume = r.director.command('resume');
  await reading;
  await r.director.command('stop');
  release();
  await resume;
  r.obs.intercept = undefined;
  await r.step();
  expect(r.director.get().held).toBe(true);
  expect(r.obs.bgm().muted).toBe(true);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.restarts()).toBe(starts);
});
it('does not grant an older resume permission after a concurrent newer stop persists', async () => {
  const r = await rig();
  await r.step();
  await r.director.command('stop');
  r.obs.bgm().muted = true;
  const starts = r.obs.restarts();
  const resume = r.director.command('resume');
  const stop = r.director.command('stop');
  await Promise.all([resume, stop]);
  await r.step();
  expect(r.director.get().held).toBe(true);
  expect(r.store.state.held).toBe(true);
  expect(r.obs.bgm().muted).toBe(true);
  expect(r.obs.restarts()).toBe(starts);
});
it('guards resume permission after playback persistence while keeping telemetry independent of commands', async () => {
  for (const newerStop of [true, false]) {
    const r = await rig();
    await r.step();
    await r.director.command('stop');
    r.obs.bgm().muted = true;
    const starts = r.obs.restarts();
    const update = r.store.update.bind(r.store);
    let writes = 0,
      release!: () => void,
      reached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    r.store.update = async (change) => {
      const write = ++writes;
      await update(change);
      if (write === 2) {
        reached();
        await blocked;
      }
    };
    const resume = r.director.command('resume');
    await preparing;
    if (newerStop) await r.director.command('stop');
    else {
      r.truth.active = 'gameplay';
      r.truth.program.map.phase = 'live';
      r.truth.program.map.score = { ct: 2, t: 3 };
      r.truth.program.clock = { phase: 'timeout_ct', endsInSeconds: 44 };
      await r.step();
    }
    expect(r.obs.bgm().muted).toBe(true);
    expect(r.obs.restarts()).toBe(starts);
    release();
    await resume;
    await r.step();
    expect(r.director.get().held).toBe(newerStop);
    expect(r.store.state.held).toBe(newerStop);
    expect(r.obs.bgm().muted).toBe(newerStop);
    expect(r.obs.restarts()).toBe(starts + (newerStop ? 0 : 1));
    if (!newerStop) expect(r.director.get().bgm?.group).toBe('tactical');
  }
});
it('plays a map opening override through the existing stinger layer without restarting it on polls', async () => {
  const r = await rig();
  await r.step();
  r.director.opening('map-opening', r.tracks[1]);
  await r.step();
  expect(r.store.state.stinger?.track.id).toBe(r.tracks[1]!.id);
  const starts = r.obs.restarts();
  await r.step();
  await r.step();
  expect(r.obs.restarts()).toBe(starts);
  expect(r.store.state.stinger?.track.id).toBe(r.tracks[1]!.id);
  r.director.opening('map-opening', r.tracks[1]);
  await r.step();
  expect(r.obs.restarts()).toBe(starts);
});
it('drops an opening queued for another map and stops an old map stinger without replay', async () => {
  const r = await rig();
  await r.step();
  r.director.opening('stale-map', r.tracks[1]);
  r.truth.program.cursor.mapEpoch++;
  await r.step();
  expect(r.obs.restarts()).toBe(1);
  r.director.opening('current-map', r.tracks[1]);
  await r.step();
  expect(r.obs.restarts()).toBe(2);
  r.truth.program.cursor.mapEpoch++;
  await r.step();
  expect(r.store.state.stinger?.finished).toBe(true);
  await r.step();
  expect(r.obs.restarts()).toBe(2);
});

async function auditionRig() {
  const r = await rig();
  await r.step();
  r.truth.production = false;
  await r.director.command('stop');
  await r.director.command('resume');
  return r;
}
function audition(
  r: Awaited<ReturnType<typeof rig>>,
  patch: Partial<MusicPreviewRequest> = {},
): MusicPreviewRequest {
  return {
    owner: randomUUID(),
    token: randomUUID(),
    operation: 1,
    expiresAt: r.now() + 4000,
    action: 'start',
    group: 'waiting',
    track: r.tracks[0]!,
    volume: 0.5,
    fadeInMs: 0,
    fadeOutMs: 0,
    confirmed: false,
    ...patch,
  };
}
function stinger(r: Awaited<ReturnType<typeof rig>>) {
  return [...r.obs.inputs].find(([name]) => name.includes('Stinger'))![1];
}
it('applies music master, mute and draft entry gain to audition', async () => {
  const r = await auditionRig();
  await r.store.update((state) => {
    state.master = 0;
    state.muted = true;
  });
  const request = audition(r, { volume: 0.5, track: { ...r.tracks[0]!, gain: 0.8 } });
  await r.director.previewRequest(request);
  await r.step(100);
  expect(stinger(r).volume).toBe(0);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.store.update((state) => {
    state.master = 0.5;
    state.muted = false;
  });
  await r.step(100);
  expect(stinger(r).volume).toBeCloseTo(0.4);
});
it.each([0, 0.5, 1])(
  'auditions unsaved volume %s and segments without altering formal playback/config/hold/consumption',
  async (volume) => {
    const r = await auditionRig();
    await r.step();
    const before = structuredClone(r.store.state);
    const request = audition(r, { volume, track: { ...r.tracks[1]!, startMs: 1000, endMs: 2500 } });
    await r.director.previewRequest(request);
    await r.step(100);
    expect(r.director.get().preview?.phase).toBe('playing');
    expect(stinger(r).volume).toBe(volume);
    expect(stinger(r).cursor).toBe(1000);
    const updated = { ...request, action: 'update' as const, operation: 2, volume: 1 - volume };
    await r.director.previewRequest(updated);
    expect(stinger(r).volume).toBe(1 - volume);
    stinger(r).cursor = 2500;
    await r.step(100);
    await r.step(100);
    expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
    expect(r.store.state).toEqual({ ...before, sources: r.store.state.sources });
    expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  },
);
it.each(['stream', 'record', 'unknown'] as const)(
  'requires current backend output confirmation for %s, with no preview mutations until confirmed',
  async (output) => {
    const r = await auditionRig();
    await r.step();
    await r.step();
    if (output === 'stream') r.obs.streamActive = true;
    else if (output === 'record') r.obs.recordActive = true;
    else r.obs.streamActive = undefined;
    const request = audition(r);
    const mark = r.obs.calls.length;
    await r.director.previewRequest(request);
    expect(r.director.get().preview?.phase).toBe('confirmation');
    expect(r.store.state.sources.stinger).toBeNull();
    expect(r.obs.calls.slice(mark).filter((c) => /^(Set|Create|Trigger)/.test(c.type))).toEqual([]);
    await r.director.previewRequest({ ...request, operation: 2, confirmed: true });
    await r.step(100);
    expect(r.director.get().preview?.phase).toBe('playing');
  },
);
it('expires an abandoned client lease and rejects late starts, foreign stops and simultaneous windows', async () => {
  const r = await auditionRig();
  await r.step();
  const request = audition(r);
  await r.director.previewRequest(request);
  await r.step(100);
  await expect(r.director.previewRequest(audition(r))).rejects.toThrow('music_preview_busy');
  await r.director.previewRequest({ ...request, owner: randomUUID(), action: 'stop' });
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.step(3000);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  await r.director.previewRequest({ ...request, action: 'stop', operation: 3 });
  await expect(r.director.previewRequest({ ...request, operation: 2 })).rejects.toThrow(
    'music_preview_stale_operation',
  );
});
it('caps a renewed lease at 15 seconds and applies the draft fade', async () => {
  const r = await auditionRig();
  await r.step();
  const request = audition(r, { fadeInMs: 1000, fadeOutMs: 1000 });
  await r.director.previewRequest(request);
  await r.step(100);
  expect(stinger(r).volume).toBe(0);
  await r.step(500);
  expect(stinger(r).volume).toBeCloseTo(0.25);
  for (let i = 1; i <= 14; i++) {
    await r.step(1000);
    await r.director.previewRequest({
      ...request,
      action: 'lease',
      operation: i + 1,
      expiresAt: r.now() + 4000,
    });
  }
  await r.step(400);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.store.state.consumed).toEqual([]);
});
it('prioritizes live safety, operator stop and OBS reconnect cleanup without replaying a preview', async () => {
  const r = await auditionRig();
  await r.step();
  const request = audition(r);
  await r.director.previewRequest(request);
  await r.step(100);
  r.truth.program.map.phase = 'live';
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.truth.program.map.phase = 'warmup';
  await r.step();
  await r.director.previewRequest(audition(r));
  await r.step(100);
  r.obs.disconnected = true;
  await r.step(100);
  expect(r.director.get().preview?.phase).toBe('cleanup');
  const restarts = r.obs.restarts();
  r.obs.disconnected = false;
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.director.get().preview?.phase).toBe('stopped');
  expect(r.director.get().preview?.message).not.toContain('未确认');
  expect(r.obs.restarts()).toBe(restarts);
  await r.director.previewRequest(audition(r));
  await r.step(100);
  await r.director.command('stop');
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.store.state.held).toBe(true);
});
it('preserves manual OBS volume/mute and does not restore an old opening after preview', async () => {
  const r = await auditionRig();
  await r.step();
  r.truth.production = true;
  r.director.opening('take-once');
  await r.step();
  await expect(r.director.previewRequest(audition(r))).rejects.toThrow(
    'music_preview_channel_busy',
  );
  stinger(r).state = 'OBS_MEDIA_STATE_ENDED';
  await r.step();
  r.truth.production = false;
  await r.step();
  const consumed = [...r.store.state.consumed];
  await r.director.previewRequest(audition(r));
  await r.step(100);
  stinger(r).volume = 0.17;
  stinger(r).muted = true;
  await r.step(100);
  await r.step(100);
  expect(stinger(r).volume).toBe(0.17);
  expect(stinger(r).muted).toBe(true);
  expect(r.store.state.held).toBe(true);
  expect(r.store.state.consumed).toEqual(consumed);
});
it('fails missing/corrupt tracks and unavailable storage before starting audio', async () => {
  const r = await auditionRig();
  await r.step();
  await rm(join(r.directory, 'tracks', r.tracks[0]!.id));
  await r.director.previewRequest(audition(r));
  expect(r.director.get().preview?.message).toContain('丢失或损坏');
  expect(r.store.state.sources.stinger).toBeNull();
  r.store.failure = true;
  await expect(r.director.previewRequest(audition(r))).rejects.toThrow('music_preview_storage');
});
it('cancels an in-flight audition before restart, and cannot resurrect a stopped operation', async () => {
  const r = await auditionRig();
  await r.step();
  const request = audition(r);
  let release!: () => void;
  let reached!: () => void;
  const reachedSettings = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.obs.intercept = async (type) => {
    if (type === 'SetInputSettings') {
      reached();
      await pending;
    }
  };
  const starting = r.director.previewRequest(request);
  await reachedSettings;
  const stopping = r.director.previewRequest({ ...request, action: 'stop', operation: 2 });
  release();
  await Promise.all([starting, stopping]);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.restarts()).toBe(1); // Only the original formal BGM restarted.
  await expect(r.director.previewRequest(request)).rejects.toThrow('music_preview_stale_operation');
  expect(r.store.state.held).toBe(false);
});
it('keeps a pre-existing hold and yields to a later real opening without consuming the audition', async () => {
  const r = await auditionRig();
  await r.director.command('stop');
  const request = audition(r);
  await r.director.previewRequest(request);
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.store.state.held).toBe(true);
  await r.director.previewRequest({ ...request, action: 'stop', operation: 2 });
  await r.director.command('resume');
  await r.step();
  await r.director.previewRequest(audition(r));
  await r.step(100);
  r.truth.production = true;
  r.director.opening('new-real-take');
  await r.step(100);
  expect(r.store.state.consumed).toEqual(['new-real-take']);
  expect(r.store.state.stinger?.key).toBe('new-real-take');
  expect(r.director.get().preview?.phase).toBe('stopped');
});

it('does not revive an expired lease when a renewal reaches the server before the next polling tick', async () => {
  const r = await auditionRig();
  await r.step();
  const request = audition(r);
  await r.director.previewRequest(request);
  await r.step(100);
  r.elapse(3100);
  await r.director.previewRequest({
    ...request,
    action: 'lease',
    operation: 2,
    expiresAt: r.now() + 4000,
  });
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.director.get().preview?.phase).toBe('stopped');
});
it('rejects an audition while formal BGM is active and permits it only after explicit stop', async () => {
  const r = await rig();
  await r.step();
  await r.director.previewRequest(audition(r));
  expect(r.director.get().preview?.message).toContain('停止音乐');
  expect(r.store.state.sources.stinger).toBeNull();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.director.command('stop');
  await r.director.previewRequest(audition(r));
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.store.state.held).toBe(true);
});
it.each(['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_PAUSED', 'muted'])(
  'refuses a borrowed channel when BGM is %s even without a formal cue',
  async (state) => {
    const r = await auditionRig();
    if (state === 'muted') r.obs.bgm().muted = true;
    else r.obs.bgm().state = state;
    await r.director.previewRequest(audition(r));
    expect(r.director.get().preview?.message).toContain('停止音乐');
    expect(r.store.state.sources.stinger).toBeNull();
  },
);
it('verifies audition stop before a newly eligible formal BGM cue starts, without mixing or restoring hold', async () => {
  const r = await auditionRig();
  await r.director.previewRequest(audition(r));
  await r.step(100);
  const mark = r.obs.calls.length;
  const previewUuid = r.store.state.sources.stinger;
  const bgmUuid = r.store.state.sources.bgm;
  r.truth.production = true;
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  const calls = r.obs.calls.slice(mark);
  const stop = calls.findIndex(
    (c) =>
      c.data.inputUuid === previewUuid &&
      c.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  );
  const verified = calls.findIndex(
    (c, i) => i > stop && c.data.inputUuid === previewUuid && c.type === 'GetMediaInputStatus',
  );
  const restart = calls.findIndex(
    (c) =>
      c.data.inputUuid === bgmUuid &&
      c.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  );
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(verified).toBeGreaterThan(stop);
  expect(restart).toBeGreaterThan(verified);
  expect(r.store.state.held).toBe(false);
});
it('does not start a formal cue while OBS has not confirmed the audition stopped', async () => {
  const r = await auditionRig();
  await r.director.previewRequest(audition(r));
  await r.step(100);
  const restarts = r.obs.restarts();
  r.obs.intercept = (type) => {
    const last = r.obs.calls.at(-1);
    if (
      type === 'GetMediaInputStatus' &&
      last?.data.inputUuid === r.store.state.sources.stinger &&
      last?.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
    )
      stinger(r).state = 'OBS_MEDIA_STATE_PLAYING'; // OBS acknowledges STOP but has not actually stopped.
    return Promise.resolve();
  };
  r.truth.production = true;
  await r.step(100);
  expect(r.director.get().preview?.phase).toBe('cleanup');
  expect(r.director.get().preview?.message).toContain('未确认');
  expect(r.obs.restarts()).toBe(restarts);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  r.obs.intercept = undefined;
  await r.step(100);
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
});

it('reports observed OBS playback separately and marks it unknown when disconnected', async () => {
  const r = await rig();
  await r.step();
  await r.step();
  expect(r.director.get().playback).toBe('playing');
  r.obs.bgm().state = 'OBS_MEDIA_STATE_PAUSED';
  await r.step();
  expect(r.director.get().playback).toBe('paused');
  expect(r.director.get().held).toBe(true);
  r.obs.disconnected = true;
  await r.step();
  expect(r.director.get().playback).toBe('unknown');
  await r.director.close();
});

it('plays a selected formal track, pauses and continues through OBS, and stops for live play', async () => {
  const r = await rig();
  await r.step();
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  expect(r.director.get().intent).toBe('manual');
  expect(r.director.get().bgm?.track).toBe(r.tracks[1]!.name);
  expect(r.director.get().playback).toBe('playing');
  await r.director.manualPause(true);
  await r.step();
  expect(r.director.get().playback).toBe('paused');
  expect(r.director.get().intent).toBe('manual');
  await r.director.manualPause(false);
  expect(r.director.get().playback).toBe('playing');
  await r.director.manualPause(true);
  r.truth.program.map.phase = 'live';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.director.get().intent).toBe('automatic');
  await r.director.close();
});

it('does not queue formal playback when OBS is disconnected', async () => {
  const r = await rig();
  await r.step();
  r.obs.disconnected = true;
  await expect(r.director.manualPlay('waiting', r.tracks[1]!.id)).rejects.toThrow();
  expect(r.director.get().intent).toBe('held');
  r.obs.disconnected = false;
  await r.step();
  expect(r.director.get().intent).toBe('held');
  await r.director.close();
});

it('waits for OBS to report an acknowledged pause and resume without sending either twice', async () => {
  const r = await rig();
  await r.step();
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  let reads = 0;
  let pending: 'pause' | 'resume' | null = null;
  r.obs.intercept = async (type) => {
    if (type === 'TriggerMediaInputAction') {
      pending = r.obs.bgm().state === 'OBS_MEDIA_STATE_PLAYING' ? 'pause' : 'resume';
      reads = 0;
    } else if (type === 'GetMediaInputStatus' && pending) {
      reads++;
      r.obs.bgm().state =
        reads < 3
          ? pending === 'pause'
            ? 'OBS_MEDIA_STATE_PLAYING'
            : 'OBS_MEDIA_STATE_PAUSED'
          : pending === 'pause'
            ? 'OBS_MEDIA_STATE_PAUSED'
            : 'OBS_MEDIA_STATE_PLAYING';
      if (reads === 3) pending = null;
    }
  };
  await r.director.manualPause(true);
  expect(r.director.get().playback).toBe('paused');
  await r.director.manualPause(false);
  expect(r.director.get().playback).toBe('playing');
  expect(
    r.obs.calls.filter(
      (call) => call.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
    ),
  ).toHaveLength(1);
  expect(
    r.obs.calls.filter((call) => call.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY'),
  ).toHaveLength(1);
  r.obs.intercept = undefined;
  await r.director.close();
});

it('keeps control unconfirmed when OBS never reports the requested pause', async () => {
  const r = await rig();
  await r.step();
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  let afterPause = false;
  r.obs.intercept = async (type) => {
    if (type === 'TriggerMediaInputAction') afterPause = true;
    if (type === 'GetMediaInputStatus' && afterPause) r.obs.bgm().state = 'OBS_MEDIA_STATE_PLAYING';
  };
  await expect(r.director.manualPause(true)).rejects.toThrow('music_state_unconfirmed');
  expect(r.director.get().held).toBe(true);
  expect(
    r.obs.calls.filter(
      (call) => call.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
    ),
  ).toHaveLength(1);
  r.obs.intercept = undefined;
  await r.director.close();
});

it('stops an audition before starting selected formal music', async () => {
  const r = await auditionRig();
  await r.director.previewRequest(audition(r));
  await r.step(100);
  expect(r.director.get().preview?.phase).toBe('playing');
  r.truth.production = true;
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  await r.step();
  expect(stinger(r).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.director.get().bgm?.track).toBe(r.tracks[1]!.name);
  await r.director.close();
});

it('lets a newer stop supersede a pending formal pause', async () => {
  const r = await rig();
  await r.step();
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  r.obs.intercept = async (type) => {
    if (type === 'GetInputSettings') {
      reached();
      await blocked;
    }
  };
  const pausing = r.director.manualPause(true);
  await pending;
  const stopping = r.director.command('stop');
  release();
  await Promise.allSettled([pausing, stopping]);
  r.obs.intercept = undefined;
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.director.get().intent).toBe('held');
  await r.director.close();
});

it('keeps formal playback beyond the audition lease without browser renewals', async () => {
  const r = await rig();
  await r.step();
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  await r.step(20_000);
  expect(r.director.get().intent).toBe('manual');
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.director.close();
});

it('allows manual selection without an automatic cue but still stops on trusted live play', async () => {
  const r = await rig();
  r.truth.production = false;
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  r.truth.program.map.phase = 'live';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  await r.director.close();
});

it('reads OBS progress and seeks only within the current segment', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.tracks[1] = { ...r.tracks[1]!, startMs: 1000, endMs: 2500 };
  await r.store.configure(config);
  await r.director.manualPlay('waiting', r.tracks[1]!.id);
  expect(r.director.get().cursorMs).toBe(1000);
  expect(r.director.get().durationMs).toBe(10000);
  await r.director.seek(2000, r.director.get().bgm!.playbackId);
  expect(r.obs.bgm().cursor).toBe(2000);
  expect(r.director.get().cursorMs).toBe(2000);
  await expect(r.director.seek(999, r.director.get().bgm!.playbackId)).rejects.toThrow(
    'music_seek_invalid',
  );
  await expect(r.director.seek(2500, r.director.get().bgm!.playbackId)).rejects.toThrow(
    'music_seek_invalid',
  );
  await r.director.manualPause(true);
  await r.director.seek(1500, r.director.get().bgm!.playbackId);
  expect(r.obs.bgm().cursor).toBe(1500);
  await expect(r.director.seek(1600, 'old-playback')).rejects.toThrow('music_seek_unavailable');
  r.obs.duration = null;
  await expect(r.director.seek(1600, r.director.get().bgm!.playbackId)).rejects.toThrow(
    'music_seek_invalid',
  );
  await r.director.close();
});

it('selects the next configured track during formal manual playback', async () => {
  const r = await rig();
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  await r.director.command('next');
  expect(r.director.get().bgm?.track).toBe(r.tracks[1]!.name);
  expect(r.director.get().intent).toBe('manual');
  await r.director.manualPause(true);
  await r.director.command('next');
  expect(r.director.get().bgm?.track).toBe(r.tracks[0]!.name);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.director.close();
});

it('monitors only owned music inputs and reads back changes and disconnection', async () => {
  const r = await rig();
  await r.director.monitor(true);
  expect(r.director.get().monitor).toBe('enabled');
  const sets = r.obs.calls.filter((c) => c.type === 'SetInputAudioMonitorType');
  expect(sets).toHaveLength(2);
  expect(sets.every((c) => c.data.monitorType === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT')).toBe(
    true,
  );
  r.obs.bgm().monitor = 'OBS_MONITORING_TYPE_NONE';
  await r.step();
  expect(r.director.get().monitor).toBe('mixed');
  await r.director.monitor(false);
  expect(r.director.get().monitor).toBe('disabled');
  r.obs.disconnected = true;
  await r.step();
  expect(r.director.get().monitor).toBe('unknown');
  await r.director.close();
});

it('reads monitoring back after a lost write acknowledgement without repeating the write', async () => {
  const r = await rig();
  await r.director.monitor(false);
  let writes = 0;
  r.obs.intercept = (type) => {
    if (type === 'SetInputAudioMonitorType') {
      writes++;
      r.obs.bgm().monitor = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
      return Promise.reject(new Error('lost acknowledgement'));
    }
    return Promise.resolve();
  };
  await expect(r.director.monitor(true)).rejects.toThrow('lost acknowledgement');
  expect(writes).toBe(1);
  expect(r.director.get().monitor).toBe('mixed');
  r.obs.intercept = undefined;
  await r.director.close();
});

it('respects OBS manual changes before a seek', async () => {
  const r = await rig();
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  r.obs.bgm().volume = 0.2;
  await expect(r.director.seek(1000, r.director.get().bgm!.playbackId)).rejects.toThrow(
    'music_source_changed',
  );
  expect(r.director.get().intent).toBe('held');
  expect(r.obs.bgm().cursor).toBe(0);
  await r.director.close();
});

it('reads a seek after a lost acknowledgement and never replays the write', async () => {
  const r = await rig();
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  let writes = 0;
  r.obs.intercept = (type) => {
    if (type === 'SetMediaInputCursor') {
      writes++;
      r.obs.bgm().cursor = 1200;
      return Promise.reject(new Error('lost acknowledgement'));
    }
    return Promise.resolve();
  };
  await expect(r.director.seek(1200, r.director.get().bgm!.playbackId)).rejects.toThrow();
  expect(writes).toBe(1);
  expect(r.director.get().cursorMs).toBe(1200);
  expect(r.director.get().intent).toBe('held');
  r.obs.intercept = undefined;
  await r.director.close();
});

it('allows a trusted match pause without any automatic cue and stops when play resumes', async () => {
  const r = await rig();
  r.truth.production = false;
  r.truth.program.map.phase = 'live';
  r.truth.program.clock = { phase: 'paused', endsInSeconds: 40 };
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  r.truth.program.clock.phase = 'freezetime';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  await r.director.close();
});

it('stops manual music when telemetry becomes stale even without a named map', async () => {
  const r = await rig();
  r.truth.program.map.phase = null;
  r.truth.program.map.name = null;
  r.truth.program.status.telemetry = 'awaiting';
  r.truth.production = false;
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  r.truth.program.status.telemetry = 'stale';
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  await expect(r.director.manualPlay('waiting', r.tracks[0]!.id)).rejects.toThrow(
    'music_program_unsafe',
  );
  await r.director.close();
});

it('recalculates the tail gain from OBS cursor after backward and forward seeks', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeOutMs = 2000;
  await r.store.configure(config);
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  r.obs.bgm().cursor = 9000;
  await r.step();
  expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  const id = r.director.get().bgm!.playbackId;
  await r.director.seek(4000, id);
  expect(r.obs.bgm().volume).toBeCloseTo(0.5);
  await r.step(2500);
  expect(r.obs.bgm().volume).toBeCloseTo(0.5);
  await r.director.seek(9500, id);
  expect(r.obs.bgm().volume).toBeCloseTo(0.125);
  await r.step(2500);
  expect(r.obs.bgm().volume).toBeCloseTo(0.125);
  await r.director.close();
});

it('freezes fades during repeated pauses and uses the paused cursor on resume', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeInMs = 2000;
  config.groups.waiting.fadeOutMs = 2000;
  await r.store.configure(config);
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  await r.step(1000);
  expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  await r.director.manualPause(true);
  await r.step(6000);
  expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  await r.director.manualPause(false);
  await r.step(500);
  expect(r.obs.bgm().volume).toBeCloseTo(0.375);
  await r.step(500);
  r.obs.bgm().cursor = 9000;
  await r.step();
  expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  for (let i = 0; i < 2; i++) {
    await r.director.manualPause(true);
    await r.step(6000);
    expect(r.obs.bgm().volume).toBeCloseTo(0.25);
    await r.director.manualPause(false);
    await r.step();
    expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  }
  await r.director.manualPause(true);
  await r.director.seek(9500, r.director.get().bgm!.playbackId);
  expect(r.obs.bgm().volume).toBeCloseTo(0.125);
  await r.step(6000);
  await r.director.manualPause(false);
  await r.step();
  expect(r.obs.bgm().volume).toBeCloseTo(0.125);
  await r.director.close();
});

it('lets stop preempt seek without a late volume write or restart', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeOutMs = 2000;
  await r.store.configure(config);
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  r.obs.bgm().cursor = 9000;
  await r.step();
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  r.obs.intercept = async (type) => {
    if (type === 'SetMediaInputCursor') {
      reached();
      await blocked;
    }
  };
  const seeking = r.director.seek(4000, r.director.get().bgm!.playbackId);
  await pending;
  const volumeWrites = r.obs.calls.filter((call) => call.type === 'SetInputVolume').length;
  const stopping = r.director.command('stop');
  release();
  await Promise.allSettled([seeking, stopping]);
  r.obs.intercept = undefined;
  await r.step();
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(r.obs.calls.filter((call) => call.type === 'SetInputVolume')).toHaveLength(volumeWrites);
  await r.director.close();
});

it('finishes a track transition without applying its tail fade to the next track', async () => {
  const r = await rig();
  const config = structuredClone(r.store.state.config);
  config.groups.waiting.fadeOutMs = 2000;
  await r.store.configure(config);
  await r.director.manualPlay('waiting', r.tracks[0]!.id);
  r.obs.bgm().cursor = 9000;
  await r.step();
  expect(r.obs.bgm().volume).toBeCloseTo(0.25);
  await r.director.command('next');
  await r.step(2100);
  expect(r.director.get().bgm?.track).toBe(r.tracks[1]!.name);
  await r.step(300);
  expect(r.obs.bgm().volume).toBeCloseTo(0.5);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  await r.director.close();
});
