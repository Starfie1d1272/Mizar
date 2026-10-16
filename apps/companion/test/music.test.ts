import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type { ObsRpc } from '../src/obs/reconcile.js';
import { MusicStore } from '../src/music/store.js';
import { MusicDirector } from '../src/music/director.js';
import type { MusicTruth } from '../src/music/cues.js';
import { musicWav } from './music-fixtures.js';

class MediaObs implements ObsRpc {
  calls: { type: string; data: Record<string, unknown> }[] = [];
  inputs = new Map<
    string,
    { uuid: string; state: string; file: string; volume: number; muted: boolean; cursor: number }
  >();
  disconnected = false;
  private inputGeneration = 0;
  intercept: ((type: string) => Promise<void>) | undefined;
  async call(type: string, data: Record<string, unknown> = {}) {
    await this.intercept?.(type);
    if (this.disconnected) throw new Error('offline');
    this.calls.push({ type, data });
    const input = data.inputUuid
      ? [...this.inputs.values()].find((i) => i.uuid === data.inputUuid)
      : this.inputs.get(String(data.inputName));
    if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
    if (type === 'GetInputList')
      return {
        inputs: [...this.inputs].map(([inputName, i]) => ({
          inputName,
          inputUuid: i.uuid,
          inputKind: 'ffmpeg_source',
        })),
      };
    if (type === 'GetSceneList') return { scenes: [{ sceneName: 'Mizar · 赛前等待' }] };
    if (type === 'GetSceneItemList')
      return { sceneItems: [...this.inputs.keys()].map((sourceName) => ({ sourceName })) };
    if (type === 'CreateInput') {
      const uuid = `uuid-${this.inputGeneration++}`;
      this.inputs.set(String(data.inputName), {
        uuid,
        state: 'OBS_MEDIA_STATE_STOPPED',
        file: '',
        volume: 1,
        muted: false,
        cursor: 0,
      });
      return { inputUuid: uuid };
    }
    if (!input) throw new Error(`Unexpected input for ${type}`);
    if (type === 'GetMediaInputStatus')
      return { mediaState: input.state, mediaCursor: input.cursor, mediaDuration: 10000 };
    if (type === 'GetInputMute') return { inputMuted: input.muted };
    if (type === 'GetInputVolume') return { inputVolumeMul: input.volume };
    if (type === 'GetInputSettings') return { inputSettings: { local_file: input.file } };
    if (type === 'SetInputSettings')
      input.file = String((data.inputSettings as { local_file: string }).local_file);
    else if (type === 'SetInputVolume') input.volume = Number(data.inputVolumeMul);
    else if (type === 'SetInputMute') input.muted = Boolean(data.inputMuted);
    else if (type === 'SetMediaInputCursor') input.cursor = Number(data.mediaCursor);
    else if (type === 'TriggerMediaInputAction') {
      input.state =
        data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
          ? 'OBS_MEDIA_STATE_PLAYING'
          : 'OBS_MEDIA_STATE_STOPPED';
      input.cursor = 0;
    } else throw new Error(`Unexpected RPC ${type}`);
    return {};
  }
  restarts() {
    return this.calls.filter(
      (c) => c.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    ).length;
  }
  bgm() {
    return [...this.inputs].find(([name]) => name.includes('BGM'))![1];
  }
}
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
    step: async (ms = 300) => {
      time += ms;
      await director.tick();
    },
  };
}
it('shares waiting across pictures and maps, loops without immediate repeats, then respects a persisted manual stop', async () => {
  const r = await rig();
  await r.step();
  expect(r.obs.restarts()).toBe(1);
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
  await r.step();
  r.director.opening('take-1');
  await r.step();
  expect(r.obs.inputs.size).toBe(2);
  expect(r.obs.bgm().state).toBe('OBS_MEDIA_STATE_PLAYING');
  expect(r.obs.restarts()).toBe(2);
  r.director.opening('take-1');
  await r.step();
  expect(r.obs.restarts()).toBe(2);
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
  for (const input of r.obs.inputs.values()) expect(input.state).toBe('OBS_MEDIA_STATE_STOPPED');
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
  expect(
    r.obs.calls
      .filter((c) => /^Set|Trigger/.test(c.type))
      .every((c) => [...r.obs.inputs.values()].some((i) => i.uuid === c.data.inputUuid)),
  ).toBe(true);
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
  await server.register(websocket);
  server.get('/', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    const handle = async (data: Buffer) => {
      const request = JSON.parse(data.toString()) as {
        op: number;
        d: { requestType: string; requestId: string; requestData: Record<string, unknown> };
      };
      if (request.op === 1) socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
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
  await config.save({ host: '127.0.0.1', port: address.port, password: '', executablePath: null });
  const provider = new ObsMusicProvider(config),
    director = new MusicDirector(r.store, provider, () => r.truth);
  try {
    await director.tick();
    expect(r.obs.restarts()).toBe(1);
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
