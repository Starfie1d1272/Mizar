import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, expect, it } from 'vitest';
import { cameraMapSchema, orchestrationPresetSchema } from '@mizar/protocol/orchestration';
import { CameraDirector } from '../src/orchestration/director.js';
import { OrchestrationStore } from '../src/orchestration/store.js';
import { MulnxProvider, type GatewayResult } from '../src/orchestration/provider.js';
import { registerOrchestrationRoutes } from '../src/orchestration/routes.js';
import { MusicStore } from '../src/music/store.js';
import { registerProductionRoutes } from '../src/program-scenes/production.js';
import type { ProgramSceneController } from '../src/program-scenes/controller.js';
import { musicProgram } from './music-fixtures.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function rig(nativeRequired = false) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-camera-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new OrchestrationStore(join(root, 'orchestration'));
  await store.load();
  const program = musicProgram();
  program.status = { context: 'fresh', telemetry: 'fresh', identity: 'matched' };
  program.series!.bindingState = 'bound';
  program.map.phase = 'warmup';
  program.map.roundNumber = 0;
  program.clock = null;
  const map = cameraMapSchema.parse({
    map: program.map.name,
    pack: '测试包',
    opening: { macro: '开场' },
    rounds: [{ macro: 'A' }, { macro: 'B' }],
    stages: { tactical: { macro: '暂停' }, halftime: { macro: '中场' } },
  });
  await store.save({ ...store.preset, maps: [map] });
  const truth = {
    program,
    active: 'waiting' as 'waiting' | 'gameplay' | 'halftime' | 'matchup',
    production: true,
    manual: false,
  };
  const calls: { type: string; macro?: string }[] = [];
  const provider = {
    connected: true,
    generation: 1,
    send: (
      type: 'CamMacro/Play' | 'CamPlay/ClearForce',
      macro?: string,
    ): Promise<GatewayResult> => {
      calls.push({ type, ...(macro ? { macro } : {}) });
      return Promise.resolve('queued');
    },
    connect: () => {
      provider.connected = true;
      provider.generation++;
      return Promise.resolve();
    },
    close: () => {
      provider.connected = false;
      provider.generation++;
    },
  };
  let time = 0;
  let isolation = true;
  const director = new CameraDirector(
    store,
    provider,
    () => truth,
    () => {},
    () => time,
    () => 0,
    () => isolation,
    nativeRequired,
  );
  director.tick();
  const resume = () => director.command('resume', director.get());
  const tick = async () => {
    director.tick();
    await Promise.resolve();
  };
  const round = async (number: number, seconds = 20) => {
    program.map.phase = 'live';
    program.map.roundNumber = number;
    program.clock = {
      phase: 'freezetime',
      endsInSeconds: seconds,
    };
    truth.active = 'gameplay';
    await tick();
  };
  const live = async () => {
    program.clock = {
      phase: 'live',
      endsInSeconds: 100,
    };
    await tick();
  };
  return {
    root,
    store,
    program,
    truth,
    calls,
    provider,
    director,
    resume,
    tick,
    round,
    live,
    setIsolation: (value: boolean) => {
      isolation = value;
    },
    advance: async (ms: number) => {
      time += ms;
      await tick();
    },
  };
}
it('only new safe rounds draw once, avoid immediate repeats, and clear before live or deadline', async () => {
  const r = await rig();
  await r.resume();
  await r.round(0);
  r.director.opening();
  await r.tick();
  expect(r.calls).toEqual([{ type: 'CamMacro/Play', macro: '开场' }]);
  expect(r.director.get()).toMatchObject({ request: 'queued', execution: 'unconfirmed' });
  r.director.opening();
  await r.tick();
  expect(r.calls).toHaveLength(1);
  await r.live();
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.round(1);
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: 'A' });
  await r.advance(6001);
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.live();
  await r.round(2);
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: 'B' });
  await r.round(2, 4);
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.live();
  const count = r.calls.length;
  await r.round(1);
  await r.live();
  await r.round(3, 4);
  expect(r.calls).toHaveLength(count);
});
it('hold, skip, manual scene control and resume consume current edges without catch-up', async () => {
  const r = await rig();
  await r.resume();
  await r.round(1);
  await r.director.command('hold');
  await r.tick();
  expect(r.director.get().held).toBe(true);
  await r.live();
  await r.round(2);
  await r.resume();
  await r.tick();
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
  await r.live();
  await r.round(3);
  await r.director.command('skip');
  await r.tick();
  expect(r.director.get().held).toBe(false);
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.live();
  await r.round(4);
  r.truth.manual = true;
  await r.tick();
  expect(r.director.get().held).toBe(true);
});
it('map/source changes, stale data and reconnect invalidate late replies and require fresh explicit arming', async () => {
  const r = await rig();
  await r.resume();
  let reply!: (r: GatewayResult) => void;
  r.provider.send = () =>
    new Promise((resolve) => {
      reply = resolve;
    });
  await r.round(1);
  const staleExpected = r.director.get();
  const playbackReply = reply;
  r.program.cursor.mapEpoch++;
  await r.tick();
  playbackReply('queued');
  await Promise.resolve();
  expect(r.director.get()).toMatchObject({ held: true, current: null });
  await expect(r.director.command('resume', staleExpected)).rejects.toThrow(
    'camera_context_changed',
  );
  reply('queued');
  await Promise.resolve();
  await r.resume();
  r.program.status.telemetry = 'stale';
  await r.tick();
  expect(r.director.get().held).toBe(true);
  r.program.status.telemetry = 'fresh';
  await r.tick();
  expect(r.director.get().held).toBe(true);
  r.provider.generation++;
  await r.tick();
  expect(r.director.get().held).toBe(true);
  await r.resume();
  await r.tick();
  expect(r.director.get().current).toBeNull();
  r.program.cursor.programSourceGeneration++;
  await r.tick();
  expect(r.director.get().held).toBe(true);
});
it('pause labels share one instance and halftime wins over paused', async () => {
  const r = await rig();
  await r.resume();
  r.program.map.phase = 'live';
  r.program.map.roundNumber = 5;
  r.program.clock = {
    phase: 'timeout_ct',
    endsInSeconds: 30,
  };
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '暂停' });
  r.program.clock.phase = 'timeout_t';
  await r.tick();
  expect(r.calls).toHaveLength(1);
  await r.live();
  r.program.map.score = { ct: 6, t: 6 };
  r.program.map.roundNumber = 12;
  r.program.clock = {
    phase: 'paused',
    endsInSeconds: 70,
  };
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '中场' });
});
it('persists validated drafts, rejects malformed imports and forbids remote control', async () => {
  const r = await rig();
  const music = new MusicStore(join(r.root, 'music'));
  await music.load();
  const app = Fastify();
  cleanup.push(() => app.close());
  registerOrchestrationRoutes(app, r.director, music, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  const post = (payload: Record<string, unknown>, origin = 'http://127.0.0.1:3000') =>
    app.inject({ method: 'POST', url: '/operator/orchestration', headers: { origin }, payload });
  const exported = orchestrationPresetSchema.parse(
    JSON.parse(await readFile(join(r.store.directory, 'preset.json'), 'utf8')),
  );
  expect(orchestrationPresetSchema.parse(exported)).toEqual(r.store.preset);
  expect(
    (
      await post({
        action: 'configure',
        preset: { ...exported, maps: [...exported.maps, ...exported.maps] },
      })
    ).statusCode,
  ).toBe(400);
  expect((await post({ action: 'hold' }, 'https://untrusted.example')).statusCode).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/local/v1/orchestration',
        headers: { host: 'remote.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await post({ action: 'configure', preset: { ...exported, name: 'RC 候选' } })).statusCode,
  ).toBe(200);
  const restored = new OrchestrationStore(r.store.directory);
  await restored.load();
  expect(restored.preset.name).toBe('RC 候选');
  await writeFile(join(r.store.directory, 'preset.json'), '{broken');
  await expect(restored.load()).rejects.toThrow();
  expect(restored.ready).toBe(false);
});
it('real websocket separates ACK, rejection and unrelated broadcasts; disconnect never replays', async () => {
  const app = Fastify();
  await app.register(websocket);
  const wires: string[] = [];
  let replyMode = 'ack';
  app.get('/', { websocket: true }, (socket) => {
    socket.on('message', (data) => {
      const wire = (
        Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data)
      ).toString();
      wires.push(wire);
      socket.send(JSON.stringify({ attackerSteamId: '0' }));
      if (replyMode === 'ack') socket.send(`已投入消息总线${wire}`);
      else if (replyMode === 'reject') socket.send(`error: ${wire} desc: missing converter`);
      else if (replyMode !== 'silent') socket.close();
    });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const provider = new MulnxProvider();
  cleanup.push(() => app.close());
  cleanup.push(() => {
    provider.close();
    return Promise.resolve();
  });
  await provider.connect(port);
  expect(await provider.send('CamMacro/Play', '中文 "宏" \\')).toBe('queued');
  expect(JSON.parse(wires[0]!)).toEqual({ type: 'CamMacro/Play', payload: '"中文 \\"宏\\" \\\\"' });
  replyMode = 'silent';
  expect(await provider.send('CamMacro/Play', '无回执')).toBe('unknown');
  expect(provider.connected).toBe(false);
  await provider.connect(port);
  replyMode = 'reject';
  expect(await provider.send('CamPlay/ClearForce')).toBe('rejected');
  replyMode = 'disconnect';
  expect(await provider.send('CamMacro/Play', '旧镜头')).toBe('unknown');
  const before = wires.length;
  await provider.connect(port);
  expect(wires).toHaveLength(before);
});
it('audition is explicit, never arms automatic mode, and refuses late live shots', async () => {
  const r = await rig();
  r.director.audition({ macro: '自选镜头', maxMs: 2000 }, r.director.get());
  await r.tick();
  expect(r.director.get()).toMatchObject({
    held: true,
    request: 'queued',
    execution: 'unconfirmed',
  });
  await r.advance(2100);
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.round(1);
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
  await r.live();
  expect(() => r.director.audition({ macro: '自选镜头', maxMs: 2000 }, r.director.get())).toThrow(
    'camera_audition_unavailable',
  );
  expect(r.director.get().held).toBe(true);
});
it('disconnect while a stop is pending cannot leave an orphan submitted state blocking re-arm', async () => {
  const r = await rig();
  await r.resume();
  await r.round(1);
  let finish!: (result: GatewayResult) => void;
  r.provider.send = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  r.director.hold();
  r.provider.close();
  await r.tick();
  finish('queued');
  await Promise.resolve();
  await r.provider.connect();
  await r.tick();
  await r.resume();
  expect(r.director.get()).toMatchObject({ held: false, current: null });
});
it('cannot arm while preset persistence is pending or with an earlier saved revision', async () => {
  const r = await rig();
  const expected = r.director.get();
  const saving = r.store.save({ ...r.store.preset, name: '新版候选' });
  expect(r.store.saving).toBe(true);
  await expect(r.director.command('resume', expected)).rejects.toThrow('camera_context_changed');
  await saving;
  await expect(r.director.command('resume', expected)).rejects.toThrow('camera_context_changed');
  await r.resume();
  expect(r.director.get().held).toBe(false);
});
it('a source reconnect or preset revision never grants a second automatic opening in the same map execution', async () => {
  const r = await rig();
  await r.resume();
  r.director.opening();
  await r.tick();
  await r.advance(6001);
  r.program.cursor.programSourceGeneration++;
  await r.tick();
  await r.resume();
  r.director.opening();
  await r.tick();
  await r.store.save({ ...r.store.preset, name: '更新名称' });
  await r.tick();
  await r.resume();
  r.director.opening();
  await r.tick();
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toEqual([
    { type: 'CamMacro/Play', macro: '开场' },
  ]);
});
it('rejects a preset whose normalized export would exceed its readable file limit', async () => {
  const r = await rig();
  const before = r.store.preset;
  const oversized = {
    ...before,
    maps: Array.from({ length: 32 }, (_, index) => ({
      ...before.maps[0]!,
      map: `de_test_${index}`,
      rounds: Array.from({ length: 64 }, () => ({ macro: '镜'.repeat(120), maxMs: 6000 })),
    })),
  };
  expect(() => r.store.save(oversized)).toThrow('256 KiB');
  expect(r.store.preset).toEqual(before);
});

async function pendingTransition() {
  const r = await rig();
  await r.resume();
  await r.round(4);
  const send = r.provider.send;
  let clear!: (result: GatewayResult) => void;
  r.provider.send = (type, macro) => {
    if (type !== 'CamPlay/ClearForce') return send(type, macro);
    r.calls.push({ type });
    return new Promise((resolve) => {
      clear = resolve;
    });
  };
  r.program.clock = { phase: 'timeout_ct', endsInSeconds: 30 };
  await r.tick();
  return { ...r, clear: (result: GatewayResult = 'queued') => clear(result) };
}
it('hands a freeze shot to a fresh tactical pause after clear ACK without claiming execution', async () => {
  const r = await pendingTransition();
  expect(r.calls).toEqual([{ type: 'CamMacro/Play', macro: 'A' }, { type: 'CamPlay/ClearForce' }]);
  r.clear();
  await r.tick();
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '暂停' });
  expect(r.calls).toHaveLength(3);
  expect(r.director.get()).toMatchObject({ execution: 'unconfirmed', request: 'queued' });
});
it('an actual opening Take replaces an older phase even when its clear is unresolved', async () => {
  const r = await rig();
  await r.resume();
  await r.round(4);
  const send = r.provider.send;
  let clear!: (value: GatewayResult) => void;
  r.provider.send = (type, macro) => {
    if (type !== 'CamPlay/ClearForce') return send(type, macro);
    r.calls.push({ type });
    return new Promise((resolve) => {
      clear = resolve;
    });
  };
  r.director.opening();
  r.director.opening();
  expect(r.calls).toHaveLength(2);
  clear('queued');
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '开场' });
  await r.tick();
  expect(r.calls).toHaveLength(3);
});
it.each([
  'hold',
  'skip',
  'map',
  'reconnect',
  'expire',
  'phase',
  'manual',
  'isolation',
  'rejected',
] as const)('drops the one-slot handoff on %s, including late ACKs', async (cancel) => {
  const r = await pendingTransition();
  if (cancel === 'hold') r.director.hold();
  else if (cancel === 'skip') await r.director.command('skip');
  else if (cancel === 'map') r.program.map.name = 'de_nuke';
  else if (cancel === 'reconnect') r.provider.generation++;
  else if (cancel === 'expire') await r.advance(1000);
  else if (cancel === 'phase') await r.live();
  else if (cancel === 'manual') r.truth.manual = true;
  else if (cancel === 'isolation') r.setIsolation(false);
  r.clear(cancel === 'rejected' ? 'rejected' : 'queued');
  await r.tick();
  await r.tick();
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toEqual([
    { type: 'CamMacro/Play', macro: 'A' },
  ]);
});
it('requires verified isolation for both enabling and audition; loss of isolation holds automation', async () => {
  const r = await rig();
  r.setIsolation(false);
  await expect(r.resume()).rejects.toThrow();
  expect(() => r.director.audition({ macro: '候选', maxMs: 1000 }, r.director.get())).toThrow();
  expect(r.calls).toEqual([]);
  r.setIsolation(true);
  await r.resume();
  await r.round(1);
  r.setIsolation(false);
  await r.tick();
  expect(r.director.get()).toMatchObject({ held: true, isolated: false });
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.live();
  await r.round(2);
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
});

async function nativeRig() {
  const r = await rig(true);
  const app = Fastify();
  cleanup.push(() => app.close());
  const music = new MusicStore(join(r.root, 'music'));
  await music.load();
  const policy = { mode: 'loopback' as const, bindHost: '127.0.0.1', allowedOrigins: [] };
  let safeExit = true;
  const production = registerProductionRoutes(app, {
    originPolicy: policy,
    hasContext: () => true,
    scenes: {
      get: () => ({ active: 'waiting', revision: 'scene' }),
      selectWaitingForExit: () => Promise.resolve({ ok: safeExit, message: 'waiting unconfirmed' }),
    } as unknown as ProgramSceneController,
    release: async () => {},
    beforeFinish: () => r.director.finishProduction(),
  });
  registerOrchestrationRoutes(app, r.director, music, policy, {
    controlToken: 'a'.repeat(64),
    configure: production.configureCameraSession,
  });
  const native = (
    payload: Record<string, unknown>,
    headers: Record<string, string> = { 'x-runtime-token': 'a'.repeat(64) },
  ) => app.inject({ method: 'POST', url: '/operator/runtime/camera-session', headers, payload });
  const camera = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/operator/orchestration',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload,
    });
  const lifecycle = async (action: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action, expectedRevision: production.get().revision },
    });
    r.truth.production = production.get().mode !== 'preparation';
    return response;
  };
  const begin = async (host: string) => {
    const response = await native({
      action: 'begin',
      host,
      expectedRevision: production.get().revision,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ lease: string }>().lease;
  };
  const arm = async () => {
    expect((await camera({ action: 'connect' })).statusCode).toBe(200);
    const { context, connection } = r.director.get();
    expect((await camera({ action: 'resume', expected: { context, connection } })).statusCode).toBe(
      200,
    );
  };
  return {
    ...r,
    app,
    native,
    camera,
    lifecycle,
    begin,
    arm,
    production,
    failExit: () => {
      safeExit = false;
    },
    allowExit: () => {
      safeExit = true;
    },
  };
}
it.each(['timeout', 'instance-invalidated', 'host-restarted'] as const)(
  'native %s latches across reconnect, resume, audition and fresh GSI until a new prepared handoff',
  async (reason) => {
    const r = await nativeRig();
    expect(r.director.get().control).toEqual({ mode: 'native', state: 'blocked' });
    expect((await r.native({ action: 'host-start', host: 'old-host' }, {})).statusCode).toBe(403);
    expect(
      (
        await r.native(
          { action: 'host-start', host: 'old-host' },
          { 'x-runtime-token': 'a'.repeat(64), origin: 'http://127.0.0.1:3000' },
        )
      ).statusCode,
    ).toBe(403);
    expect((await r.native({ action: 'host-start', host: 'old-host' })).statusCode).toBe(200);
    const oldLease = await r.begin('old-host');
    expect((await r.lifecycle('enter')).statusCode).toBe(200);
    await r.arm();
    await r.round(1);
    expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
    if (reason === 'timeout') await r.advance(6001);
    else if (reason === 'instance-invalidated')
      await r.native({ action: 'invalidate', host: 'old-host', lease: oldLease });
    else await r.native({ action: 'host-start', host: 'new-host' });
    await r.tick();
    expect(r.director.get()).toMatchObject({
      held: true,
      connected: false,
      control: { mode: 'native', state: 'blocked' },
    });
    expect(
      (await r.native({ action: 'pulse', host: 'old-host', lease: oldLease })).statusCode,
    ).toBe(409);
    expect((await r.camera({ action: 'connect' })).statusCode).toBe(400);
    const { context, connection } = r.director.get();
    expect(
      (await r.camera({ action: 'resume', expected: { context, connection } })).statusCode,
    ).toBe(400);
    expect(
      (
        await r.camera({
          action: 'audition',
          stage: 'round',
          index: 0,
          expected: { context, connection },
        })
      ).statusCode,
    ).toBe(400);
    await r.live();
    await r.round(2);
    r.director.opening();
    expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
    expect(
      (await r.camera({ action: 'browser', expectedRevision: r.production.get().revision }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await r.native({
          action: 'begin',
          host: 'old-host',
          expectedRevision: r.production.get().revision,
        })
      ).statusCode,
    ).toBe(409);
    r.failExit();
    expect((await r.lifecycle('finish')).statusCode).toBe(409);
    expect(
      (await r.camera({ action: 'browser', expectedRevision: r.production.get().revision }))
        .statusCode,
    ).toBe(400);
    r.allowExit();
    expect((await r.lifecycle('finish')).statusCode).toBe(200);
    await r.native({ action: 'host-start', host: 'new-host' });
    const newLease = await r.begin('new-host');
    expect(newLease).not.toBe(oldLease);
    // Late packets cannot renew or revoke the new borrow.
    expect(
      (await r.native({ action: 'pulse', host: 'old-host', lease: oldLease })).statusCode,
    ).toBe(409);
    await r.native({ action: 'invalidate', host: 'old-host', lease: oldLease });
    expect(
      (await r.native({ action: 'pulse', host: 'new-host', lease: newLease })).statusCode,
    ).toBe(200);
    expect((await r.lifecycle('enter')).statusCode).toBe(200);
    await r.arm();
    await r.tick();
    expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
    await r.live();
    await r.round(3);
    expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(2);
  },
);
it('browser fallback is an explicit prepared mode and remains independent of Host restarts and lease expiry', async () => {
  const r = await nativeRig();
  expect((await r.camera({ action: 'connect' })).statusCode).toBe(400);
  expect((await r.camera({ action: 'browser', expectedRevision: 'old' })).statusCode).toBe(400);
  expect(
    (await r.camera({ action: 'browser', expectedRevision: r.production.get().revision }))
      .statusCode,
  ).toBe(200);
  expect((await r.lifecycle('enter')).statusCode).toBe(200);
  await r.arm();
  await r.round(1);
  await r.native({ action: 'host-start', host: 'host-one' });
  await r.native({ action: 'host-start', host: 'host-two' });
  await r.advance(60_000);
  await r.live();
  await r.round(2);
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(2);
  expect(r.director.get().control).toEqual({ mode: 'browser', state: 'ready' });
  // A fresh product Companion never restores a previous native or browser arm intent.
  const restarted = await rig(true);
  expect(restarted.director.get()).toMatchObject({
    held: true,
    control: { mode: 'native', state: 'blocked' },
  });
});
it('native expiry drops a pending clear handoff and a late gateway ACK cannot restore it', async () => {
  const r = await nativeRig();
  await r.native({ action: 'host-start', host: 'host' });
  const lease = await r.begin('host');
  await r.lifecycle('enter');
  await r.arm();
  await r.round(1);
  let clear!: (result: GatewayResult) => void;
  r.provider.send = (type, macro) => {
    r.calls.push({ type, ...(macro ? { macro } : {}) });
    return type === 'CamPlay/ClearForce'
      ? new Promise((resolve) => {
          clear = resolve;
        })
      : Promise.resolve('queued');
  };
  await r.live();
  await r.round(2);
  await r.advance(6001);
  clear('queued');
  await r.tick();
  expect((await r.native({ action: 'pulse', host: 'host', lease })).statusCode).toBe(409);
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
  expect(r.director.get().held).toBe(true);
});

it('healthy native renewals preserve manual hold across rounds without restoring automatic intent', async () => {
  const r = await nativeRig();
  await r.native({ action: 'host-start', host: 'host' });
  const lease = await r.begin('host');
  await r.lifecycle('enter');
  await r.arm();
  await r.round(1);
  expect((await r.camera({ action: 'hold' })).statusCode).toBe(200);
  for (let round = 2; round <= 4; round++) {
    await r.advance(4000);
    expect((await r.native({ action: 'pulse', host: 'host', lease })).statusCode).toBe(200);
    await r.live();
    await r.round(round);
  }
  expect(r.director.get()).toMatchObject({
    held: true,
    control: { mode: 'native', state: 'ready' },
  });
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
});
