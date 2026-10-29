import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, expect, it, vi } from 'vitest';
import { cameraMapSchema, orchestrationPresetSchema } from '@mizar/protocol/orchestration';
import { CameraDirector } from '../src/orchestration/director.js';
import { OrchestrationStore } from '../src/orchestration/store.js';
import { MulnxProvider, type GatewayResult } from '../src/orchestration/provider.js';
import { registerOrchestrationRoutes } from '../src/orchestration/routes.js';
import { MulnxTool } from '../src/orchestration/tool.js';
import { MusicStore } from '../src/music/store.js';
import { registerProductionRoutes } from '../src/program-scenes/production.js';
import type { ProgramSceneController } from '../src/program-scenes/controller.js';
import {
  DemoTestController,
  readDemoTestRecovery,
  registerDemoTestRoutes,
} from '../src/demo-test/controller.js';
import { musicProgram } from './music-fixtures.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('migrates the legacy active preset and retains its identity on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-camera-migration-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'orchestration');
  await mkdir(directory);
  const preset = { format: 'mizar.orchestration', version: 1, name: '旧预设', maps: [] };
  await writeFile(join(directory, 'preset.json'), JSON.stringify(preset));
  const store = new OrchestrationStore(directory);
  await store.load();
  const restored = new OrchestrationStore(directory);
  await restored.load();
  expect(restored.preset).toEqual(preset);
  expect(restored.activePresetId).toBe(store.activePresetId);
  expect(restored.presets).toEqual([{ id: store.activePresetId, preset }]);
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
    demoAudition: undefined as boolean | undefined,
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
      type: 'CamMacro/Play' | 'CamPack/Apply' | 'CamPlay/ClearForce',
      macro?: string,
    ): Promise<GatewayResult> => {
      if (type !== 'CamPack/Apply') calls.push({ type, ...(macro ? { macro } : {}) });
      return Promise.resolve('queued');
    },
    packStatus: (): Promise<{ active: string | null; empty: boolean } | null> =>
      Promise.resolve({ active: '测试包', empty: true }),
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
it('marks the automatic preference as saving until it is persisted', async () => {
  const r = await rig();
  await r.store.saveAutomaticEnabled(true);
  const pending = r.store.saveAutomaticEnabled(false);
  expect(r.store.saving).toBe(true);
  await pending;
  expect(r.store.saving).toBe(false);
  expect(r.store.automaticEnabled).toBe(false);
});

it('keeps the current shot while drafts are written', async () => {
  const r = await rig();
  await r.resume();
  await r.round(0);
  r.director.opening();
  await r.tick();
  const id = await r.store.createPreset();
  for (const write of [
    () => r.store.createPreset(),
    () => r.store.createPreset(id),
    () => r.store.savePreset(id, { ...r.store.preset, name: '编辑' }),
  ]) {
    const pending = write();
    expect(r.store.saving).toBe(false);
    await r.tick();
    await pending;
    expect(r.calls).toEqual([{ type: 'CamMacro/Play', macro: '开场' }]);
  }
});

it('persists a catalog larger than the ordinary receipt limit', async () => {
  const r = await rig();
  const shot = { macro: 'x'.repeat(110), maxMs: 6000 };
  const maps = Array.from({ length: 16 }, (_, index) => ({
    map: `de_map${index}`,
    pack: '包',
    rounds: Array.from({ length: 64 }, () => shot),
  }));
  await r.store.savePreset(r.store.activePresetId, { ...r.store.preset, maps });
  for (let i = 0; i < 18; i++) await r.store.createPreset(r.store.activePresetId);
  const file = await readFile(join(r.store.directory, 'presets.json'));
  expect(file.byteLength).toBeGreaterThan(2 * 1024 * 1024);
  const restored = new OrchestrationStore(r.store.directory);
  await restored.load();
  expect(restored.presets).toHaveLength(19);
});

it('new round shots draw once, continue into live play and clear at their deadline', async () => {
  const r = await rig();
  await r.resume();
  await r.round(0);
  r.director.opening();
  await r.tick();
  expect(r.calls).toEqual([{ type: 'CamMacro/Play', macro: '开场' }]);
  expect(r.director.get()).toMatchObject({ request: 'queued' });
  r.director.opening();
  await r.tick();
  expect(r.calls).toHaveLength(1);
  await r.live();
  expect(r.calls).toHaveLength(1);
  await r.advance(6001);
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
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: 'B' });
  await r.live();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: 'B' });
  await r.advance(6001);
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  const count = r.calls.length;
  await r.round(1);
  await r.live();
  await r.round(3, 4);
  expect(r.calls).toHaveLength(count + 1);
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: 'A' });
  await r.advance(6001);
  const beforeLateRound = r.calls.length;
  r.program.map.roundNumber = 4;
  await r.live();
  expect(r.calls).toHaveLength(beforeLateRound);
});
it('hold, skip and resume consume current edges without catch-up', async () => {
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
  expect(r.director.get().held).toBe(false);
});
it('map/source changes and reconnect invalidate readiness while preserving automatic intent', async () => {
  const r = await rig();
  await r.resume();
  const old = r.director.get();
  r.program.cursor.mapEpoch++;
  await r.tick();
  expect(r.director.get()).toMatchObject({ held: false, preparation: 'waiting' });
  await expect(r.director.command('resume', old)).rejects.toThrow('camera_context_changed');
  await r.tick();
  await r.tick();
  await r.tick();
  expect(r.director.get()).toMatchObject({ held: false, preparation: 'ready' });
  r.provider.generation++;
  await r.tick();
  expect(r.director.get()).toMatchObject({ held: false, preparation: 'waiting' });
  await r.tick();
  await r.tick();
  await r.tick();
  expect(r.director.get()).toMatchObject({ held: false, preparation: 'ready' });
});
it('pause labels share one instance and halftime wins over paused', async () => {
  const r = await rig();
  const map = r.store.preset.maps[0]!;
  await r.store.save({
    ...r.store.preset,
    maps: [
      {
        ...map,
        pauseCandidates: { tactical: [{ macro: '暂停候选', maxMs: 2000 }], technical: [] },
      },
    ],
  });
  await r.resume();
  r.program.map.phase = 'live';
  r.program.map.roundNumber = 5;
  r.program.clock = {
    phase: 'timeout_ct',
    endsInSeconds: 30,
  };
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '暂停候选' });
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
it('only arms after the applied pack and empty lists are read back in the same context', async () => {
  const r = await rig();
  r.provider.packStatus = () => Promise.resolve({ active: 'other', empty: true });
  await expect(r.resume()).rejects.toThrow('camera_pack_unconfirmed');
  await expect(
    r.director.audition({ macro: '候选', maxMs: 1000 }, r.director.get()),
  ).rejects.toThrow('camera_pack_unconfirmed');
  expect(r.calls).toEqual([]);
  expect(r.director.get().held).toBe(true);
  r.provider.packStatus = () => Promise.resolve({ active: '测试包', empty: false });
  await expect(r.resume()).rejects.toThrow('camera_pack_unconfirmed');
  let finish!: (status: { active: string | null; empty: boolean } | null) => void;
  r.provider.packStatus = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = r.resume();
  await Promise.resolve();
  r.director.hold();
  finish({ active: '测试包', empty: true });
  await expect(pending).rejects.toThrow('camera_context_changed');
  expect(r.director.get().held).toBe(true);
  r.director.invalidatePreparation();
  const stale = r.resume();
  await Promise.resolve();
  r.director.invalidatePreparation();
  finish({ active: '测试包', empty: true });
  await expect(stale).rejects.toThrow('camera_pack_unconfirmed');
  expect(r.director.get()).toMatchObject({ held: true, preparation: 'waiting' });
});
it('newer manual intent wins while automatic resume awaits preparation', async () => {
  const r = await rig();
  let finish!: (status: { active: string | null; empty: boolean } | null) => void;
  r.provider.packStatus = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const resume = r.resume();
  await Promise.resolve();
  const audition = r.director.audition({ macro: '手动', maxMs: 2000 }, r.director.get());
  finish({ active: '测试包', empty: true });
  await expect(resume).rejects.toThrow('camera_context_changed');
  await audition;
  expect(r.director.get()).toMatchObject({ held: true, current: '手动' });
});
it('persists validated drafts, rejects malformed imports and forbids remote control', async () => {
  const r = await rig();
  const music = new MusicStore(join(r.root, 'music'));
  await music.load();
  const app = Fastify();
  cleanup.push(() => app.close());
  registerOrchestrationRoutes(
    app,
    r.director,
    music,
    {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: [],
    },
    { controlToken: undefined, configure: () => {}, canPrepare: () => !r.truth.production },
  );
  r.truth.production = false;
  await r.tick();
  const send = vi.spyOn(r.provider, 'send');
  const post = (payload: Record<string, unknown>, origin = 'http://127.0.0.1:3000') =>
    app.inject({ method: 'POST', url: '/operator/orchestration', headers: { origin }, payload });
  const exported = orchestrationPresetSchema.parse(r.store.preset);
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
  expect((await post({ action: 'set-automatic', enabled: true })).json()).toMatchObject({
    automaticEnabled: true,
  });
  const activeId = r.store.activePresetId;
  const created = (await post({ action: 'create-preset', sourceId: activeId })).json<{
    createdPresetId: string;
  }>();
  const id = created.createdPresetId;
  expect(id).not.toBe(activeId);
  expect(
    (await post({ action: 'save-preset', id, preset: { ...exported, name: '草稿' } })).statusCode,
  ).toBe(200);
  expect(r.store.preset.name).toBe('RC 候选');
  const revision = r.store.revision;
  expect((await post({ action: 'activate-preset', id })).statusCode).toBe(200);
  expect(r.store.preset.name).toBe('草稿');
  expect(r.store.revision).toBe(revision + 1);
  expect(send).not.toHaveBeenCalled();
  const restored = new OrchestrationStore(r.store.directory);
  await restored.load();
  expect(restored.preset.name).toBe('草稿');
  expect(restored.activePresetId).toBe(id);
  expect(restored.presets).toHaveLength(2);
  expect(restored.automaticEnabled).toBe(true);
  r.truth.production = true;
  r.director.beginProduction();
  await r.tick();
  expect(r.director.get().held).toBe(false);
  expect((await post({ action: 'set-automatic', enabled: false })).statusCode).toBe(400);
  r.director.hold();
  r.provider.generation++;
  await r.tick();
  expect(r.director.get().held).toBe(true);
  r.truth.production = false;
  await r.tick();
  expect((await post({ action: 'set-automatic', enabled: false })).statusCode).toBe(200);
  r.truth.production = true;
  r.director.beginProduction();
  await r.tick();
  expect(r.director.get().held).toBe(true);
  await writeFile(join(r.store.directory, 'presets.json'), '{broken');
  await expect(restored.load()).rejects.toThrow();
  expect(restored.ready).toBe(false);
});
it('reports MulNX update check failures without exposing internal errors and permits retry', async () => {
  const r = await rig();
  const app = Fastify();
  cleanup.push(() => app.close());
  const music = new MusicStore(join(r.root, 'music'));
  const tool = new MulnxTool(join(r.root, 'mulnx'), join(r.root, 'bundle'));
  const check = vi.spyOn(tool, 'check');
  check.mockRejectedValueOnce(new Error('mulnx_metadata_http_403'));
  check.mockRejectedValueOnce(new Error('private diagnostic'));
  check.mockResolvedValueOnce(tool.view());
  registerOrchestrationRoutes(
    app,
    r.director,
    music,
    {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: [],
    },
    undefined,
    tool,
  );
  const post = () =>
    app.inject({
      method: 'POST',
      url: '/operator/orchestration',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'check-tool' },
    });
  const limited = await post();
  expect(limited.statusCode).toBe(400);
  expect(limited.json<{ message: string }>().message).toContain('GitHub 拒绝了请求');
  const other = await post();
  expect(other.statusCode).toBe(400);
  expect(other.json<{ message: string }>().message).toBe('无法检查 MulNX 更新，请检查网络后重试。');
  expect(other.body).not.toContain('private diagnostic');
  expect((await post()).statusCode).toBe(200);
});
it('real websocket separates ACK, rejection and unrelated broadcasts; disconnect never replays', async () => {
  const app = Fastify();
  await app.register(websocket);
  const wires: string[] = [];
  let replyMode = 'ack';
  let ackFirst = false;
  app.get('/', { websocket: true }, (socket) => {
    socket.on('message', (data) => {
      const wire = (
        Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data)
      ).toString();
      const command = JSON.parse(wire) as { type: string; payload: string };
      if (command.type === 'WebSocket/SelectChannel' && command.payload === 'events') {
        socket.send(JSON.stringify({ type: 'WebSocket/ChannelSelected', payload: 'events' }));
        return;
      }
      wires.push(wire);
      socket.send(JSON.stringify({ attackerSteamId: '0' }));
      if (command.type === 'CamPack/Status' && ackFirst) socket.send(`已投入消息总线${wire}`);
      if (command.type === 'CamPack/Status') {
        socket.send(
          JSON.stringify({
            type: 'CamPack/Status',
            requestId: 'old',
            active: 'wrong',
            OnNewRoundEmpty: true,
            OnRoundStartEmpty: true,
            OnRoundEndEmpty: true,
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'CamPack/Status',
            requestId: JSON.parse(command.payload) as string,
            active: 'Mizar_pack',
            OnNewRoundEmpty: true,
            OnRoundStartEmpty: true,
            OnRoundEndEmpty: true,
          }),
        );
      }
      if (replyMode === 'ack') {
        if (!(command.type === 'CamPack/Status' && ackFirst)) socket.send(`已投入消息总线${wire}`);
      } else if (replyMode === 'unsupported')
        socket.send(`error: ${wire} desc: unregister cmd: ${command.type} on: fixture`);
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
  expect(await provider.send('CS2BootLoader/Launch')).toBe('queued');
  expect(JSON.parse(wires.shift()!)).toEqual({ type: 'CS2BootLoader/Launch', payload: '' });
  expect(await provider.send('CamPack/Apply', 'Mizar_pack')).toBe('queued');
  expect(JSON.parse(wires.shift()!)).toEqual({ type: 'CamPack/Apply', payload: '"Mizar_pack"' });
  expect(await provider.packStatus()).toEqual({ active: 'Mizar_pack', empty: true });
  expect((JSON.parse(wires.shift()!) as { type: string }).type).toBe('CamPack/Status');
  ackFirst = true;
  expect(await provider.packStatus()).toEqual({ active: 'Mizar_pack', empty: true });
  wires.shift();
  expect(await provider.send('CamMacro/Play', '中文 "宏" \\')).toBe('queued');
  expect(JSON.parse(wires[0]!)).toEqual({ type: 'CamMacro/Play', payload: '"中文 \\"宏\\" \\\\"' });
  replyMode = 'silent';
  expect(await provider.send('CamMacro/Play', '无回执')).toBe('unknown');
  expect(provider.connected).toBe(false);
  await provider.connect(port);
  replyMode = 'reject';
  expect(await provider.send('CamPlay/ClearForce')).toBe('rejected');
  expect(await provider.stopControl()).toBe('rejected');
  expect(JSON.parse(wires.at(-1)!)).toEqual({ type: 'System/Stop', payload: '' });
  expect(provider.connected).toBe(false);
  await provider.connect(port);
  replyMode = 'ack';
  const generation = provider.generation;
  expect(await provider.stopControl()).toBe('queued');
  expect(provider.connected).toBe(false);
  expect(provider.generation).toBeGreaterThan(generation);
  expect(await provider.send('CamMacro/Play', '停止后的旧镜头')).toBe('unknown');
  await provider.connect(port);
  replyMode = 'disconnect';
  expect(await provider.send('CamMacro/Play', '旧镜头')).toBe('unknown');
  const before = wires.length;
  await provider.connect(port);
  expect(wires).toHaveLength(before);
});
it('audition works during live rounds and manual scene control without arming automatic mode', async () => {
  const r = await rig();
  await r.director.audition({ macro: '自选镜头', maxMs: 2000 }, r.director.get());
  await r.tick();
  expect(r.director.get()).toMatchObject({
    held: true,
    request: 'queued',
  });
  r.director.opening();
  expect(r.calls).toEqual([{ type: 'CamMacro/Play', macro: '自选镜头' }]);
  await r.advance(2100);
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  await r.round(1);
  expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toHaveLength(1);
  await r.live();
  r.truth.manual = true;
  r.program.series!.bindingState = 'needs_operator';
  await r.director.audition({ macro: '自选镜头', maxMs: 2000 }, r.director.get());
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '自选镜头' });
  expect(r.director.get().held).toBe(true);
  await r.director.audition({ macro: '另一个镜头', maxMs: 2000 }, r.director.get());
  expect(r.calls.slice(-2)).toEqual([
    { type: 'CamPlay/ClearForce' },
    { type: 'CamMacro/Play', macro: '另一个镜头' },
  ]);
  expect(r.director.get()).toMatchObject({ held: true });
  r.program.series!.bindingState = 'bound';
  await r.resume();
  expect(r.calls.at(-1)).toEqual({ type: 'CamPlay/ClearForce' });
  expect(r.director.get()).toMatchObject({ held: false, current: null });
});
it('disconnect while a stop is pending cannot leave an orphan submitted state blocking re-arm', async () => {
  const r = await rig();
  await r.resume();
  await r.round(1);
  let finish!: (result: GatewayResult) => void;
  r.provider.send = (type) =>
    type === 'CamPack/Apply'
      ? Promise.resolve('queued')
      : new Promise((resolve) => {
          finish = resolve;
        });
  r.director.hold();
  r.provider.close();
  await r.tick();
  finish('queued');
  await Promise.resolve();
  await r.provider.connect();
  await r.tick();
  r.provider.send = () => Promise.resolve('queued');
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
it('an automatic opening can play in a live round and is not repeated after reconnect or preset revision', async () => {
  const r = await rig();
  r.program.cursor.mapEpoch++;
  await r.round(0);
  await r.resume();
  await r.live();
  r.director.opening();
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '开场' });
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
  await r.tick();
  expect(r.calls.at(-1)).toEqual({ type: 'CamMacro/Play', macro: '暂停' });
  expect(r.calls).toHaveLength(3);
  expect(r.director.get()).toMatchObject({ request: 'queued' });
});
it('does not start a queued round shot after freeze time ends', async () => {
  const r = await rig();
  await r.resume();
  await r.round(1);
  const send = r.provider.send;
  let clear!: (result: GatewayResult) => void;
  r.provider.send = (type, macro) => {
    if (type !== 'CamPlay/ClearForce') return send(type, macro);
    r.calls.push({ type });
    return new Promise((resolve) => {
      clear = resolve;
    });
  };
  await r.round(2, 0.1);
  await r.live();
  clear('queued');
  await r.tick();
  expect(r.calls.filter((call) => call.type === 'CamMacro/Play')).toEqual([
    { type: 'CamMacro/Play', macro: 'A' },
  ]);
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
it.each(['hold', 'skip', 'map', 'reconnect', 'expire', 'phase', 'isolation', 'rejected'] as const)(
  'drops the one-slot handoff on %s, including late ACKs',
  async (cancel) => {
    const r = await pendingTransition();
    if (cancel === 'hold') r.director.hold();
    else if (cancel === 'skip') await r.director.command('skip');
    else if (cancel === 'map') r.program.map.name = 'de_nuke';
    else if (cancel === 'reconnect') r.provider.generation++;
    else if (cancel === 'expire') await r.advance(1000);
    else if (cancel === 'phase') await r.live();
    else if (cancel === 'isolation') r.setIsolation(false);
    r.clear(cancel === 'rejected' ? 'rejected' : 'queued');
    await r.tick();
    await r.tick();
    expect(r.calls.filter((c) => c.type === 'CamMacro/Play')).toEqual([
      { type: 'CamMacro/Play', macro: 'A' },
    ]);
  },
);
it('requires verified isolation for both enabling and audition; loss of isolation holds automation', async () => {
  const r = await rig();
  r.setIsolation(false);
  await expect(r.resume()).rejects.toThrow();
  await expect(
    r.director.audition({ macro: '候选', maxMs: 1000 }, r.director.get()),
  ).rejects.toThrow();
  expect(r.calls).toEqual([]);
  r.setIsolation(true);
  await r.resume();
  await r.round(1);
  r.setIsolation(false);
  await r.tick();
  expect(r.director.get()).toMatchObject({ held: false, isolated: false });
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

it('accepts a managed Host handoff, renews beyond the lease period and isolates on exit', async () => {
  const r = await nativeRig();
  expect((await r.native({ action: 'host-start', host: 'managed-host' })).statusCode).toBe(200);
  const lease = await r.begin('managed-host');
  expect((await r.lifecycle('enter')).statusCode).toBe(200);
  await r.arm();
  for (let i = 0; i < 4; i++) {
    await r.advance(4000);
    expect((await r.native({ action: 'pulse', host: 'managed-host', lease })).statusCode).toBe(200);
  }
  expect(r.director.get().control).toEqual({ mode: 'native', state: 'ready' });
  expect((await r.native({ action: 'invalidate', host: 'managed-host', lease })).statusCode).toBe(
    200,
  );
  expect(r.director.get()).toMatchObject({
    held: true,
    connected: false,
    control: { state: 'blocked' },
  });
  expect((await r.native({ action: 'pulse', host: 'managed-host', lease })).statusCode).toBe(409);
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

it('isolates external Demo camera leases and restores manual-only recovery after restart', async () => {
  const r = await nativeRig();
  const requestId = 'ca05aade-2287-42be-9320-87abae5ac312';
  const markerPath = join(r.root, 'demo-test.json');
  let dataReady = false;
  let quarantined = false;
  let restored = 0;
  const options = {
    markerPath,
    recovery: undefined,
    dataReady: () => dataReady,
    diagnostic: () => {},
    context: { beginTemporary: async () => {}, endTemporary: () => {} },
    runtime: { flushSeriesProgressCheckpoint: async () => {}, resetSession: () => {} },
    scenes: { get: () => ({ revision: 'scene' }), select: () => Promise.resolve({ ok: true }) },
    production: r.production,
    obs: () => Promise.resolve({ connection: 'connected', streaming: false }),
    quarantineOutput: (value: boolean) => {
      quarantined = value;
    },
    refresh: () => {},
    restoreFormal: () => {
      restored++;
      return Promise.resolve();
    },
    hold: () => {},
  } as unknown as ConstructorParameters<typeof DemoTestController>[0];
  const trial = new DemoTestController(options);
  expect(
    (await trial.command({ action: 'begin', requestId, gameOwnership: 'external' })).code,
  ).toBe(200);
  expect(quarantined).toBe(true);
  expect(trial.canAcceptGsi()).toBe(false);
  expect(() => trial.configureCameraSession('stale', () => {})).toThrow(
    'demo_camera_session_changed',
  );
  let configured = false;
  trial.configureCameraSession(requestId, () => {
    configured = true;
  });
  expect(configured).toBe(true);
  expect(trial.canUseCamera('connect')).toBe(true);
  expect(trial.canUseCamera('audition')).toBe(false);
  expect((await trial.command({ action: 'playing', requestId })).code).toBe(200);
  dataReady = true;
  expect(trial.canUseCamera('audition')).toBe(true);
  expect(trial.canAcceptGsi()).toBe(true);
  for (const action of ['resume', 'configure', 'browser'])
    expect(trial.canUseCamera(action)).toBe(false);
  expect(() => trial.configureCameraSession(requestId, () => {})).toThrow();
  const recovery = readDemoTestRecovery(markerPath);
  expect(recovery?.gameOwnership).toBe('external');
  const restarted = new DemoTestController({ ...options, recovery });
  await restarted.recover();
  expect(restarted.canAcceptGsi()).toBe(false);
  expect(restarted.canUseCamera('connect')).toBe(false);
  expect(restarted.canUseCamera('disconnect')).toBe(true);
  expect((await restarted.command({ action: 'complete', requestId })).code).toBe(200);
  expect(restored).toBe(1);
  expect(quarantined).toBe(false);
  expect(restarted.canAcceptGsi()).toBe(false);
  expect(readDemoTestRecovery(markerPath)).toBeUndefined();
  restarted.openFormalBoundary();
  expect(restarted.canAcceptGsi()).toBe(true);
});

it('auditions isolated Demo data without formal series binding and never enables automatic cues', async () => {
  const r = await rig();
  r.truth.manual = true;
  r.truth.demoAudition = true;
  r.truth.program.series!.bindingState = 'unbound';
  await r.director.command('connect');
  r.director.tick();
  const { context, connection } = r.director.get();
  await expect(r.director.command('resume', { context, connection })).rejects.toThrow();
  await r.director.audition(r.store.preset.maps[0]!.opening!, { context, connection });
  expect(r.director.get().held).toBe(true);
  expect(r.calls.some((call) => call.type === 'CamMacro/Play')).toBe(true);
  r.truth.demoAudition = false;
  r.director.tick();
  await expect(
    r.director.audition(r.store.preset.maps[0]!.opening!, r.director.get()),
  ).rejects.toThrow();
});

it.each(['owned', 'external'] as const)(
  'production finish preserves an active %s Demo recovery transaction until host completion',
  async (ownership) => {
    const root = await mkdtemp(join(tmpdir(), 'mizar-active-demo-exit-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const app = Fastify();
    cleanup.push(() => app.close());
    const markerPath = join(root, 'demo-test.json');
    const requestId = 'ba05aade-2287-42be-9320-87abae5ac312';
    let safe = false;
    let scene = 'gameplay';
    let temporary = false;
    let quarantined = false;
    let formalRestores = 0;
    const scenes = {
      get: () => ({ revision: 'scene', active: scene }),
      select: () => {
        if (safe) scene = 'waiting';
        return Promise.resolve({ ok: safe, message: 'waiting unconfirmed' });
      },
      selectWaitingForExit: () =>
        Promise.resolve({
          ok: scene === 'waiting',
          message: 'waiting unconfirmed',
        }),
    } as unknown as ProgramSceneController;
    const production = registerProductionRoutes(app, {
      originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
      hasContext: () => true,
      scenes,
      finishTrial: () => trial.finish(),
      release: async () => {},
    });
    const trial = new DemoTestController({
      markerPath,
      dataReady: () => true,
      diagnostic: () => {},
      context: {
        beginTemporary: () => {
          temporary = true;
          return Promise.resolve();
        },
        endTemporary: () => {
          temporary = false;
        },
      },
      runtime: { flushSeriesProgressCheckpoint: async () => {}, resetSession: () => {} },
      scenes,
      production,
      obs: () => Promise.resolve({ connection: 'connected', streaming: false }),
      quarantineOutput: (value: boolean) => {
        quarantined = value;
      },
      refresh: () => {},
      restoreFormal: () => {
        formalRestores++;
        return Promise.resolve();
      },
      hold: () => {},
    } as unknown as ConstructorParameters<typeof DemoTestController>[0]);
    const token = 'a'.repeat(64);
    registerDemoTestRoutes(app, trial, token);
    const demo = (action: string, extra = {}) =>
      app.inject({
        method: 'POST',
        url: '/operator/runtime/demo-test',
        headers: { 'x-runtime-token': token },
        payload: { action, requestId, ...extra },
      });
    const finish = () =>
      app.inject({
        method: 'POST',
        url: '/operator/production',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { action: 'finish', expectedRevision: production.get().revision },
      });
    expect(
      (await demo('begin', ownership === 'external' ? { gameOwnership: 'external' } : {}))
        .statusCode,
    ).toBe(200);
    let cameraConfigured = false;
    trial.configureCameraSession(requestId, () => {
      cameraConfigured = true;
    });
    expect(cameraConfigured).toBe(true);
    expect(trial.canUseCamera('audition')).toBe(false);
    expect((await demo('playing')).statusCode).toBe(200);
    expect(trial.canUseCamera('audition')).toBe(true);
    expect(trial.get()).toMatchObject({ active: true, phase: 'playing' });
    const marker = readDemoTestRecovery(markerPath);
    expect(marker?.requestId).toBe(requestId);
    expect((await finish()).statusCode).toBe(409);
    expect(scene).toBe('gameplay');
    expect(production.get().mode).toBe('live');
    expect(readDemoTestRecovery(markerPath)).toEqual(marker);
    expect(temporary && quarantined).toBe(true);
    expect(formalRestores).toBe(0);
    safe = true;
    expect((await finish()).statusCode).toBe(200);
    expect(scene).toBe('waiting');
    expect(production.get().mode).toBe('preparation');
    expect(trial.get().active).toBe(true);
    expect(production.isTrialPending()).toBe(true);
    expect(readDemoTestRecovery(markerPath)).toEqual(marker);
    expect(temporary && quarantined).toBe(true);
    expect(formalRestores).toBe(0);
    // Native game cleanup/quarantine uses finish once more before complete.
    expect((await demo('finish')).statusCode).toBe(200);
    expect(readDemoTestRecovery(markerPath)).toEqual(marker);
    expect((await demo('complete')).statusCode).toBe(200);
    expect(formalRestores).toBe(1);
    expect(temporary || quarantined).toBe(false);
    expect(production.isTrialPending()).toBe(false);
    expect(readDemoTestRecovery(markerPath)).toBeUndefined();
  },
);

it('shares metadata requests and respects GitHub retry times', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ tag: 'v1' })))
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ tag: 'v2' })));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { publicJson } = await import('../src/orchestration/tool-release.js');
    const [a, b] = await Promise.all([publicJson('release'), publicJson('release')]);
    expect(a).toEqual(b);
    await publicJson('release');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(publicJson('notice')).rejects.toThrow('mulnx_metadata_http_429');
    await expect(publicJson('other')).rejects.toThrow('mulnx_metadata_http_429');
    vi.advanceTimersByTime(119_000);
    await expect(publicJson('other')).rejects.toThrow('mulnx_metadata_http_429');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    await expect(publicJson('other')).resolves.toEqual({ tag: 'v2' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it('keeps the longest concurrent GitHub secondary limit', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  let finish!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', {
        status: 403,
        headers: { 'retry-after': '300', 'x-ratelimit-remaining': '10' },
      }),
    )
    .mockReturnValueOnce(delayed)
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { publicJson } = await import('../src/orchestration/tool-release.js');
    const first = publicJson('first');
    const second = publicJson('second');
    await expect(first).rejects.toThrow('mulnx_metadata_http_403');
    finish(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    await expect(second).rejects.toThrow('mulnx_metadata_http_429');
    vi.advanceTimersByTime(60_000);
    await expect(publicJson('third')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(240_000);
    await expect(publicJson('third')).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
it('receives HSI input without a pending command and separates reconnects', async () => {
  const app = Fastify();
  await app.register(websocket);
  const requests: string[] = [];
  app.get('/', { websocket: true }, (socket) => {
    socket.on('message', (data) => {
      requests.push(
        (Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data)
        ).toString(),
      );
      const event = {
        eventType: 'player_hurt',
        sequence: 1,
        captureGeneration: 2,
        capturedAtUnixMs: 100,
        attackerSteamId: '0',
        victimSteamId: '76561198000000001',
        weapon: 'awp',
        dmgHealth: 40,
        health: 60,
        hitgroup: 1,
      };
      socket.send(
        JSON.stringify({
          eventType: 'game_clock',
          sampledAtUnixMs: 99,
          timeDomain: 'network_game_client_tick',
          captureGeneration: 2,
          readSucceeded: true,
          tick: 122,
        }),
      );
      socket.send(JSON.stringify({ type: 'WebSocket/ChannelSelected', payload: 'legacy' }));
      socket.send(
        JSON.stringify({
          eventType: 'game_clock',
          sampledAtUnixMs: 99,
          timeDomain: 'network_game_client_tick',
          captureGeneration: 2,
          readSucceeded: true,
          tick: 122,
        }),
      );
      socket.send(JSON.stringify({ type: 'WebSocket/ChannelSelected', payload: 'events' }));
      socket.send(JSON.stringify({ ...event, sequence: 2 }));
      socket.send(
        JSON.stringify({
          eventType: 'game_clock',
          sampledAtUnixMs: 100,
          timeDomain: 'network_game_client_tick',
          captureGeneration: 2,
          readSucceeded: true,
          tick: 123,
        }),
      );
      socket.send(JSON.stringify({ ...event, sequence: 3, captureGeneration: 1 }));
      socket.send(JSON.stringify({ ...event, sequence: 4 }));
      socket.send(JSON.stringify({ ...event, sequence: 4 }));
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
  const messages: import('../src/orchestration/provider.js').MulnxInput[] = [];
  provider.subscribeInput((message) => messages.push(message));
  await provider.connect(port);
  await vi.waitFor(() =>
    expect(requests).toEqual([
      JSON.stringify({ type: 'WebSocket/SelectChannel', payload: 'events' }),
    ]),
  );
  await vi.waitFor(() =>
    expect(messages.filter((message) => message.kind === 'event')).toHaveLength(1),
  );
  expect(messages.find((message) => message.kind === 'clock')).toMatchObject({
    generation: provider.generation,
    sample: { tick: 123, readSucceeded: true },
  });
  expect(messages.filter((message) => message.kind === 'clock')).toHaveLength(1);
  const firstGeneration = provider.generation;
  await provider.connect(port);
  await vi.waitFor(() =>
    expect(messages.filter((message) => message.kind === 'event')).toHaveLength(2),
  );
  expect(
    messages.filter((message) => message.kind === 'event').map((message) => message.generation),
  ).toEqual([firstGeneration, provider.generation]);
  expect(messages.some((message) => message.kind === 'disconnected')).toBe(true);
});
