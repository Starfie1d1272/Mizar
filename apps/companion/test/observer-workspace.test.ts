import { execFileSync } from 'node:child_process';
import { ObserverSettingsStore } from '../src/telemetry/observer-settings.js';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import {
  WorkspaceObserver,
  prepareObserverOutputParent,
  installedWorkspaceObserver,
  registerWorkspaceObserver,
} from '../src/telemetry/observer-workspace.js';

const commands = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/telemetry/observer-game-control.js', async (original) => ({
  ...(await original<typeof import('../src/telemetry/observer-game-control.js')>()),
  sendObserverGameCommand: commands.send,
}));
const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
async function fixture(
  run: (observer: WorkspaceObserver, app: FastifyInstance) => Promise<void>,
  beforeLaunch?: () => Promise<void>,
) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'mizar-observer-workspace-'));
  const observer = new WorkspaceObserver(async () => {
    await beforeLaunch?.();
    return {
      role: 'lookahead',
      python: process.execPath,
      node: process.execPath,
      driver,
      native: driver,
      steamApi: driver,
      parserWorker: driver,
      hostVersion: 14192,
      outputDirectory: join(outputDirectory, randomUUID()),
    };
  });
  const app = Fastify();
  registerWorkspaceObserver(app, observer, 'synthetic-capability');
  try {
    await run(observer, app);
  } finally {
    await observer.close();
    await app.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
describe('workbench observer ownership', () => {
  it('reports output failure after joining the child and permits a fresh connection', () =>
    fixture(async (observer) => {
      const recorded: unknown[] = [];
      observer.subscribeEvidence(() => {
        throw new Error('diagnostic-listener-secret');
      });
      observer.subscribeEvidence((entry) => recorded.push(entry));
      await observer.start(driver, '127.0.0.3:27020', 'synthetic-only');
      await expect.poll(() => observer.view().active).toBe(false);
      expect(observer.view().failed).toBe(true);
      expect(recorded).toHaveLength(1);
      expect(JSON.stringify(recorded)).not.toContain('diagnostic-listener-secret');
      await observer.start(driver, '127.0.0.1:27020', 'synthetic-only');
      await expect.poll(() => observer.source.getHealth().state).toBe('live');
      expect(observer.view().failed).toBe(false);
    }));
  it('keeps connection preparation within production eligibility', () =>
    fixture(async (observer) => {
      const app = Fastify();
      registerWorkspaceObserver(app, observer, 'synthetic-capability', () => false);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/operator/runtime/observer',
          headers: { 'x-runtime-token': 'synthetic-capability' },
          payload: {
            action: 'start',
            executable: driver,
            job: 'Local\\MizarObserver-test',
            endpoint: '127.0.0.1:27020',
            password: 'synthetic-only',
          },
        });
        expect(response.statusCode).toBe(409);
        expect(observer.view().active).toBe(false);
      } finally {
        await app.close();
      }
    }));
  it('starts, delivers privately, stops and starts a fresh source through native commands', () =>
    fixture(async (observer, app) => {
      const events: unknown[] = [];
      observer.source.subscribeLiveGameEvents((event) => events.push(event));
      const headers = { 'x-runtime-token': 'synthetic-capability' };
      const payload = {
        action: 'start',
        executable: driver,
        job: 'Local\\MizarObserver-test',
        endpoint: '127.0.0.1:27020',
        password: 'synthetic-only',
      };
      expect(
        (await app.inject({ method: 'POST', url: '/operator/runtime/observer', headers, payload }))
          .statusCode,
      ).toBe(200);
      await expect.poll(() => observer.source.getRecentGameEvents().length).toBe(1);
      expect(observer.source.getHealth().role).toBe('lookahead');
      const first = observer.source.getRecentGameEvents()[0]!.cursor.generation;
      expect(events).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/operator/runtime/observer',
            headers,
            payload: { action: 'stop' },
          })
        ).statusCode,
      ).toBe(200);
      expect(observer.view().active).toBe(false);
      expect(observer.source.getHealth().state).toBe('stopped');
      expect(
        (await app.inject({ method: 'POST', url: '/operator/runtime/observer', headers, payload }))
          .statusCode,
      ).toBe(200);
      await expect.poll(() => observer.source.getRecentGameEvents().length).toBe(1);
      expect(observer.source.getRecentGameEvents()[0]!.cursor.generation).toBeGreaterThan(first);
      expect(events).toHaveLength(2);
      expect(
        JSON.stringify((await app.inject({ url: '/local/v1/observer' })).json()),
      ).not.toContain('synthetic-only');
    }));
  it('requires the private host capability and a native request origin', () =>
    fixture(async (observer, app) => {
      for (const headers of [
        {},
        { 'x-runtime-token': 'synthetic-capability', origin: 'http://127.0.0.1:3000' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/operator/runtime/observer',
              headers,
              payload: { action: 'stop' },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(observer.view().active).toBe(false);
    }));
  it('expires a missing game/host heartbeat and joins the owned process', () =>
    fixture(async (observer) => {
      await observer.start(driver, '127.0.0.1:27020', 'synthetic-only');
      await expect.poll(() => observer.source.getHealth().state).toBe('live');
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000);
      try {
        await expect.poll(() => observer.view().active, { timeout: 4000 }).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
      expect(observer.source.getHealth().state).toBe('stopped');
    }));
});

it('rechecks the enabled configuration after waiting for an earlier observer to stop', () =>
  fixture(async (observer) => {
    const app = Fastify(),
      settings = new ObserverSettingsStore();
    await settings.configure({ ...settings.settings, enabled: true });
    settings.setConnection({
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'synthetic',
    });
    registerWorkspaceObserver(app, observer, 'synthetic-capability', () => true, settings);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped = vi.spyOn(observer, 'stop').mockImplementationOnce(() => gate);
    const start = vi.spyOn(observer, 'start');
    try {
      const pending = app
        .inject({
          method: 'POST',
          url: '/operator/runtime/observer',
          headers: { 'x-runtime-token': 'synthetic-capability' },
          payload: {
            action: 'start-configured',
            executable: driver,
            game: '42-1',
            job: 'Local\\MizarObserver-test',
            revision: (
              await app.inject({
                method: 'POST',
                url: '/operator/runtime/observer',
                headers: { 'x-runtime-token': 'synthetic-capability' },
                payload: {
                  action: 'prepare',
                  game: '42-1',
                  job: 'Local\\MizarObserver-test',
                  useMulnx: false,
                },
              })
            ).json<{ revision: string }>().revision,
          },
        })
        .then((response) => response);
      await expect.poll(() => stopped.mock.calls.length).toBe(1);
      await settings.configure({ ...settings.settings, enabled: false });
      release();
      expect((await pending).statusCode).toBe(409);
      expect(start).not.toHaveBeenCalled();
    } finally {
      release();
      await app.close();
    }
  }));

it('routes standard observers and MulNX game automation independently', () =>
  fixture(async (observer) => {
    for (const scenario of [
      { useMulnx: false, enabled: true, command: false },
      { useMulnx: true, enabled: false, command: true },
      { useMulnx: true, enabled: true, command: true },
    ]) {
      const app = Fastify();
      const settings = new ObserverSettingsStore();
      await settings.configure({ ...settings.settings, enabled: scenario.enabled });
      await settings.configureGame({ autoConnect: true, hideGameHud: false });
      settings.setConnection({
        earlyEndpoint: '127.0.0.1:27025',
        programEndpoint: '127.0.0.1:27026',
        password: 'synthetic',
      });
      registerWorkspaceObserver(app, observer, 'synthetic-capability', () => true, settings);
      const start = vi.spyOn(observer, 'start').mockResolvedValue();
      commands.send.mockClear();
      const response = await app.inject({
        method: 'POST',
        url: '/operator/runtime/observer',
        headers: { 'x-runtime-token': 'synthetic-capability' },
        payload: {
          action: 'start-configured',
          executable: driver,
          game: '42-1',
          job: 'Local\\MizarObserver-test',
          revision: (
            await app.inject({
              method: 'POST',
              url: '/operator/runtime/observer',
              headers: { 'x-runtime-token': 'synthetic-capability' },
              payload: {
                action: 'prepare',
                game: '42-1',
                job: 'Local\\MizarObserver-test',
                useMulnx: scenario.useMulnx,
              },
            })
          ).json<{ revision: string }>().revision,
          useMulnx: scenario.useMulnx,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(start).toHaveBeenCalledTimes(Number(scenario.enabled));
      expect(commands.send).toHaveBeenCalledTimes(Number(scenario.command));
      if (scenario.command) expect(commands.send.mock.calls[0]![0]).toContain('27026');
      expect((await app.inject('/local/v1/observer')).json()).toMatchObject({
        programCommandQueued: scenario.command,
      });
      start.mockRestore();
      await app.close();
    }
  }));

async function configuredFixture(
  run: (context: {
    observer: WorkspaceObserver;
    settings: ObserverSettingsStore;
    app: FastifyInstance;
    request: (payload: Record<string, unknown>) => Promise<LightMyRequestResponse>;
    prepare: (game?: string) => Promise<Record<string, unknown>>;
    start: (game?: string) => Promise<LightMyRequestResponse>;
  }) => Promise<void>,
) {
  await fixture(async (observer) => {
    const app = Fastify();
    const settings = new ObserverSettingsStore();
    await settings.configure({ ...settings.settings, enabled: true });
    await settings.configureGame({ autoConnect: true, hideGameHud: false });
    settings.setConnection({
      earlyEndpoint: '127.0.0.1:27020',
      programEndpoint: '127.0.0.1:27021',
      password: 'synthetic',
    });
    registerWorkspaceObserver(app, observer, 'synthetic-capability', () => true, settings);
    const request = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/operator/runtime/observer',
        headers: { 'x-runtime-token': 'synthetic-capability' },
        payload,
      });
    const prepare = async (game = '42-1') =>
      (
        await request({ action: 'prepare', game, job: 'Local\\MizarObserver-test', useMulnx: true })
      ).json<Record<string, unknown>>();
    const start = async (game = '42-1') =>
      request({
        action: 'start-configured',
        executable: driver,
        game,
        job: 'Local\\MizarObserver-test',
        useMulnx: true,
        revision: (await prepare(game)).revision,
        hudOriginal: 0,
      });
    commands.send.mockClear();
    try {
      await run({ observer, settings, app, request, prepare, start });
    } finally {
      await app.close();
    }
  });
}

it('preserves live source and program connection across timing, duplicate saves and concurrent returns', () =>
  configuredFixture(async ({ observer, settings, prepare, start }) => {
    const launch = vi.spyOn(observer, 'start');
    expect((await start()).statusCode).toBe(200);
    await expect.poll(() => observer.source.getHealth().state).toBe('live');
    const generation = observer.source.getHealth().generation;
    const revision = (await prepare()).revision;
    await settings.configure({ ...settings.settings, leadSeconds: 10, expectedDelaySeconds: 130 });
    settings.setConnection({ ...settings.configured()! });
    await settings.configureGame({ ...settings.gameAutomation });
    expect(await prepare()).toMatchObject({ reuse: true, revision });
    expect((await Promise.all([start(), start()])).map((r) => r.statusCode)).toEqual([200, 200]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(commands.send).toHaveBeenCalledTimes(1);
    expect(observer.source.getHealth().generation).toBe(generation);
  }));

it('restarts only the early source when assistance is re-enabled in the leased session', () =>
  configuredFixture(async ({ observer, settings, start, prepare }) => {
    expect((await start()).statusCode).toBe(200);
    await expect.poll(() => observer.source.getHealth().state).toBe('live');
    const generation = observer.source.getHealth().generation;
    await settings.configure({ ...settings.settings, enabled: false });
    await expect.poll(() => observer.view().active).toBe(false);
    await settings.configure({ ...settings.settings, enabled: true });
    await expect.poll(() => observer.source.getHealth().state).toBe('live');
    expect(observer.source.getHealth().generation).toBeGreaterThan(generation);
    expect(commands.send).toHaveBeenCalledTimes(1);
    expect(await prepare()).toMatchObject({ reuse: true });
  }));

it('retries a failed early launch without repeating the successful game command', () =>
  configuredFixture(async ({ observer, app, start }) => {
    const launch = vi
      .spyOn(observer, 'start')
      .mockRejectedValueOnce(new Error('synthetic_launch_failure'));
    expect((await start()).statusCode).toBe(409);
    expect((await app.inject('/local/v1/observer')).json()).toMatchObject({
      error: 'observer_operation_failed',
      retryAvailable: true,
    });
    expect((await start()).statusCode).toBe(200);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(commands.send).toHaveBeenCalledTimes(1);
    expect(
      (await app.inject('/local/v1/observer')).json<{ error: string | null }>().error,
    ).toBeNull();
  }));

it('rejects an old prepared game after a new game is prepared and rejects an old connection revision', () =>
  configuredFixture(async ({ settings, observer, prepare, request, start }) => {
    const previous = await prepare();
    await prepare('43-1');
    const payload = {
      action: 'start-configured',
      executable: driver,
      game: '42-1',
      job: 'Local\\MizarObserver-test',
      useMulnx: true,
      revision: previous.revision,
    };
    expect((await request(payload)).statusCode).toBe(409);
    const next = await prepare('43-1');
    const draftRevision = settings.revision;
    settings.setConnection({ ...settings.configured()!, earlyEndpoint: '127.0.0.1:27022' });
    expect((await request({ ...payload, game: '43-1', revision: next.revision })).statusCode).toBe(
      409,
    );
    expect(
      (
        await request({
          action: 'prepare',
          game: '43-1',
          job: 'Local\\MizarObserver-test',
          useMulnx: true,
          expectedRevision: draftRevision,
        })
      ).statusCode,
    ).toBe(409);
    expect(commands.send).not.toHaveBeenCalled();
    expect(observer.view().active).toBe(false);
    expect((await start('43-1')).statusCode).toBe(200);
  }));

it('keeps a rejected program submission retryable without launching the early source first', () =>
  configuredFixture(async ({ observer, start }) => {
    const launch = vi.spyOn(observer, 'start');
    commands.send.mockRejectedValueOnce(new Error('synthetic program rejection'));
    expect((await start()).statusCode).toBe(409);
    expect(launch).not.toHaveBeenCalled();
    expect(observer.view().active).toBe(false);
    expect((await start()).statusCode).toBe(200);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(commands.send).toHaveBeenCalledTimes(2); // Rejected first; only the second submission is accepted.
  }));

it.each([false, true])(
  'switches both endpoints for a second map and retries only its failed early source (MulNX=%s)',
  (useMulnx) =>
    configuredFixture(async ({ observer, settings, request }) => {
      const connect = async () => {
        const body = { game: '42-1', job: 'Local\\MizarObserver-test', useMulnx };
        const prepared = (
          await request({ ...body, action: 'prepare', expectedRevision: settings.revision })
        ).json<{ revision: string }>();
        return request({
          ...body,
          action: 'start-configured',
          executable: driver,
          revision: prepared.revision,
        });
      };
      const launch = vi.spyOn(observer, 'start');
      expect((await connect()).statusCode).toBe(200);
      await expect.poll(() => observer.source.getHealth().state).toBe('live');
      const generation = observer.source.getHealth().generation;
      const stop = vi.spyOn(observer, 'stop');
      settings.setConnection({
        earlyEndpoint: '127.0.0.2:27035',
        programEndpoint: '127.0.0.2:27036',
        password: 'second-map',
      });
      launch.mockRejectedValueOnce(new Error('synthetic second-map early launch failure'));
      expect((await connect()).statusCode).toBe(409);
      expect(stop).toHaveBeenCalled();
      expect(commands.send).toHaveBeenCalledTimes(useMulnx ? 2 : 0);
      if (useMulnx) expect(commands.send.mock.calls[1]![0]).toContain('connect 127.0.0.2:27036');
      expect((await connect()).statusCode).toBe(200);
      await expect.poll(() => observer.source.getHealth().state).toBe('live');
      expect(observer.source.getHealth().generation).toBeGreaterThan(generation);
      expect(launch.mock.calls.at(-1)?.slice(1, 3)).toEqual(['127.0.0.2:27035', 'second-map']);
      expect(commands.send).toHaveBeenCalledTimes(useMulnx ? 2 : 0);
    }),
);

it('cancels an in-flight start before a newer connection starts and never stops the newer owner', () =>
  configuredFixture(async ({ observer, settings, start, app }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped = vi.spyOn(observer, 'stop').mockImplementationOnce(() => gate);
    const old = start();
    await expect.poll(() => stopped.mock.calls.length).toBe(1);
    settings.setConnection({
      earlyEndpoint: '127.0.0.2:27035',
      programEndpoint: '127.0.0.2:27036',
      password: 'second-map',
    });
    const fresh = start();
    release();
    expect((await old).statusCode).toBe(409);
    expect((await fresh).statusCode).toBe(200);
    expect((await app.inject('/local/v1/observer')).json()).toMatchObject({
      active: true,
      pending: false,
    });
    expect(commands.send).toHaveBeenCalledTimes(2);
    expect(commands.send.mock.calls[0]![0]).toContain('127.0.0.1:27021');
    expect(commands.send.mock.calls[1]![0]).toContain('127.0.0.2:27036');
  }));

it('does not resume an explicitly stopped or expired Host session when settings are enabled again', () =>
  configuredFixture(async ({ observer, settings, start, request, app }) => {
    await start();
    await request({ action: 'stop' });
    await settings.configure({ ...settings.settings, enabled: false });
    await settings.configure({ ...settings.settings, enabled: true });
    expect(observer.view().active).toBe(false);
    await start();
    await settings.configure({ ...settings.settings, enabled: false });
    await expect.poll(() => observer.view().active).toBe(false);
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000);
    try {
      await request({ action: 'pulse' });
      await settings.configure({ ...settings.settings, enabled: true });
      expect(observer.view().active).toBe(false);
      await expect
        .poll(
          async () =>
            (await app.inject('/local/v1/observer')).json<{ retryAvailable: boolean }>()
              .retryAvailable,
        )
        .toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  }));

it('cancels component resolution before spawning a process', async () => {
  let release!: () => void;
  let resolving!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    resolving = resolve;
  });
  await fixture(
    async (observer) => {
      const pending = observer.start(driver, '127.0.0.1:27020', 'synthetic-only');
      const rejected = expect(pending).rejects.toThrow('observer_configuration_changed');
      await entered;
      const stop = observer.stop();
      release();
      await rejected;
      await stop;
      expect(observer.view().active).toBe(false);
      expect(observer.source.getHealth().generation).toBe(0);
    },
    async () => {
      resolving();
      await gate;
    },
  );
});

it('lets Host restore changed HUD preferences without restarting either connection', () =>
  configuredFixture(async ({ settings, observer, prepare, start }) => {
    await settings.configureGame({ autoConnect: true, hideGameHud: true });
    expect((await start()).statusCode).toBe(200);
    const generation = observer.source.getHealth().generation;
    expect(await prepare()).toMatchObject({ reuse: true });
    await settings.configureGame({ autoConnect: true, hideGameHud: false });
    expect(await prepare()).toMatchObject({ reuse: false, hideGameHud: false });
    expect((await start()).statusCode).toBe(200);
    expect(observer.source.getHealth().generation).toBe(generation);
    expect(commands.send).toHaveBeenCalledTimes(1);
    await settings.configureGame({ autoConnect: true, hideGameHud: true });
    expect(await prepare()).toMatchObject({ reuse: false, hideGameHud: true });
    expect((await start()).statusCode).toBe(200);
    expect(commands.send.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      expect.stringContaining('27021'),
      'cl_draw_only_deathnotices 1',
    ]);
    expect(observer.source.getHealth().generation).toBe(generation);
  }));

it('stops the old source even if the next preparation arrives before its queued stop runs', () =>
  configuredFixture(async ({ observer, settings, prepare, start }) => {
    await start();
    settings.setConnection({ ...settings.configured()!, earlyEndpoint: '127.0.0.1:27022' });
    expect(await prepare()).toMatchObject({ reuse: false });
    await expect.poll(() => observer.view().active).toBe(false);
    expect(commands.send).toHaveBeenCalledTimes(1);
  }));

it('preserves an accepted game action on same-instance re-entry and connects on new program endpoint or game identity', () =>
  configuredFixture(async ({ observer, settings, start, request }) => {
    expect((await start()).statusCode).toBe(200);
    const generation = observer.source.getHealth().generation;
    await request({ action: 'stop' });
    expect((await start()).statusCode).toBe(200);
    expect(observer.source.getHealth().generation).toBeGreaterThan(generation);
    expect(commands.send).toHaveBeenCalledTimes(1);
    settings.setConnection({ ...settings.configured()!, programEndpoint: '127.0.0.1:27023' });
    expect((await start()).statusCode).toBe(200);
    expect(commands.send).toHaveBeenCalledTimes(2);
    expect(commands.send.mock.calls[1]![0]).toContain('27023');
    expect((await start('43-1')).statusCode).toBe(200);
    expect(commands.send).toHaveBeenCalledTimes(3);
  }));

it('creates only observer ancestors, reuses them, and rejects files, links and unwritable parents', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-observer-目录 space-'));
  try {
    const parent = await prepareObserverOutputParent(root);
    expect(parent).toBe(join(root, 'data/observer'));
    expect(await readdir(parent)).toEqual([]);
    expect(await prepareObserverOutputParent(root)).toBe(parent);
    await rm(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data'), 'not a directory');
    await expect(prepareObserverOutputParent(root)).rejects.toThrow();
    await rm(join(root, 'data'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareObserverOutputParent(root)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await rm(join(root, 'data'));
    if (process.platform !== 'win32') {
      await mkdir(join(root, 'data'), { mode: 0o500 });
      await expect(prepareObserverOutputParent(root)).rejects.toThrow();
      await chmod(join(root, 'data'), 0o700);
    }
  } finally {
    await chmod(join(root, 'data'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds failed attempt history across fresh starts while keeping current success clean', () =>
  fixture(async (observer) => {
    for (let i = 0; i < 10; i++) {
      await observer.start(driver, '127.0.0.12:27020', 'history-private-secret');
      await expect.poll(() => observer.view().active).toBe(false);
    }
    expect(observer.view().history).toHaveLength(8);
    expect(new Set(observer.view().history.map((entry) => entry.attemptId)).size).toBe(8);
    expect(new Set(observer.view().history.map((entry) => entry.sessionId)).size).toBe(8);
    await observer.start(driver, '127.0.0.1:27020', 'history-private-secret');
    await expect.poll(() => observer.view().health.state).toBe('live');
    expect(observer.view().failed).toBe(false);
    expect(observer.view().terminal).toBeUndefined();
    expect(JSON.stringify(observer.view())).not.toContain('history-private-secret');
  }));

it.each(['portable', 'installed'])(
  'prepares the %s output parent and classifies preparation failure before spawning',
  async (distribution) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-installed-observer-'));
    if (distribution === 'installed') await writeFile(join(root, 'installed.flag'), '');
    const localAppData = join(root, 'AppData Local');
    const state = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const {writableRoot} = await import(process.argv[1]); console.log(writableRoot(process.argv[2]));',
        new URL('../../../scripts/qualification/product-runtime.mjs', import.meta.url).href,
        root,
      ],
      { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: localAppData } },
    ).trim();
    expect(state).toBe(
      distribution === 'installed' ? join(localAppData, 'Mizar') : join(root, 'state'),
    );
    const entries = {
      python: 'runtime/python/python.exe',
      driver: 'client/driver.py',
      native: 'client/cs2_observer.dll',
      worker: 'client/parser_worker.mjs',
    };
    try {
      await mkdir(state, { recursive: true });
      for (const path of Object.values(entries)) {
        const destination = join(root, 'resources/observer', path);
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, 'synthetic non-executable component');
      }
      await writeFile(
        join(root, 'resources/observer/manifest.json'),
        JSON.stringify({
          componentVersion: '1.0.0',
          sourceSha: '4b07fd0ddfb775d8fa1548bddfd98dc78c7fce93',
          distribution: 'external-node',
          entrypoints: entries,
          filesSha256: Object.fromEntries(
            Object.values(entries).map((path) => [
              path,
              createHash('sha256').update('synthetic non-executable component').digest('hex'),
            ]),
          ),
        }),
      );
      await mkdir(join(root, 'game/csgo'), { recursive: true });
      await writeFile(join(root, 'game/csgo/steam.inf'), 'PatchVersion=1.41.9.2');
      // The synthetic component manifest tests assembly only; no pinned component is replaced.
      const observer = installedWorkspaceObserver(
        root,
        state,
        join(root, 'missing-launcher'),
        'Local\\MizarObserver-test',
      );
      try {
        await writeFile(join(state, 'data'), 'not a directory');
        await expect(
          observer.start(join(root, 'game/bin/win64/cs2.exe'), '127.0.0.1:27025', 'private'),
        ).rejects.toThrow('output-parent-unavailable');
        expect(observer.view().terminal).toMatchObject({
          stage: 'output-parent',
          reason: 'output-parent-unavailable',
          ready: false,
        });
        expect(observer.view().history).toHaveLength(1);
        await rm(join(state, 'data'));
        await observer.start(join(root, 'game/bin/win64/cs2.exe'), '127.0.0.1:27025', 'private');
        await expect.poll(() => observer.view().active).toBe(false);
        expect(observer.view().terminal).toMatchObject({ stage: 'spawn', spawnCode: 'ENOENT' });
        expect(await readdir(join(state, 'data/observer'))).toEqual([]);
        expect(observer.view().history).toHaveLength(2);
      } finally {
        await observer.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
