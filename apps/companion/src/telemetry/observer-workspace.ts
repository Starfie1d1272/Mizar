import { readFile, lstat } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCstvSourceManager, type CstvSourceManager } from './cstv-source-manager.js';
import { startObserverProcess, type ObserverProcessOptions } from './observer-process.js';
import type { ObserverSettingsStore } from './observer-settings.js';
import { sendObserverGameCommand, observerConnectCommand } from './observer-game-control.js';

export const OBSERVER_VERSION = '1.0.0';
const SOURCE_SHA = '4b07fd0ddfb775d8fa1548bddfd98dc78c7fce93';
type Owner = ReturnType<typeof startObserverProcess<'lookahead'>>;

/** The stable source facade keeps existing private consumers subscribed across attempts. */
export class WorkspaceObserver {
  private current: CstvSourceManager<'lookahead'> = createCstvSourceManager({ role: 'lookahead' });
  private owner: Owner | undefined;
  private listeners = new Set<() => void>();
  private events = new Set<
    Parameters<CstvSourceManager<'lookahead'>['subscribeLiveGameEvents']>[0]
  >();
  private unsubscribe: (() => void)[] = [];
  private queue = Promise.resolve();
  private lease = 0;
  private watchdog: ReturnType<typeof setInterval>;
  private closing = false;
  private terminal: Awaited<Owner['closed']>['terminal'] | undefined;
  private failed = false;
  private launched = false;
  private generationBase = 0;
  private event(event: ReturnType<CstvSourceManager<'lookahead'>['getRecentGameEvents']>[number]) {
    return {
      ...event,
      cursor: { ...event.cursor, generation: event.cursor.generation + this.generationBase },
    };
  }
  private health() {
    const health = this.current.getHealth();
    return { ...health, generation: health.generation + this.generationBase };
  }
  readonly source: CstvSourceManager<'lookahead'>;

  constructor(
    private readonly launch: (
      executable: string,
    ) => Promise<Omit<ObserverProcessOptions<'lookahead'>, 'endpoint' | 'password'>>,
    initialSource?: CstvSourceManager<'lookahead'>,
  ) {
    if (initialSource) this.current = initialSource;
    this.source = {
      role: 'lookahead',
      start: () => this.current.start(),
      stop: () => this.close(),
      getHealth: () => this.health(),
      getSnapshot: () => ({
        health: this.health(),
        recentGameEvents: this.current.getRecentGameEvents().map((e) => this.event(e)),
        recentDiagnostics: this.current.getRecentDiagnostics(),
      }),
      getRecentDiagnostics: () => this.current.getRecentDiagnostics(),
      getRecentGameEvents: () => this.current.getRecentGameEvents().map((e) => this.event(e)),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      subscribeLiveGameEvents: (listener) => {
        this.events.add(listener);
        return () => {
          this.events.delete(listener);
        };
      },
    };
    this.watchdog = setInterval(() => {
      if (this.owner && performance.now() - this.lease > 6000)
        void this.stop().catch(() => console.error('observer_lease_finalization_failed'));
    }, 1000);
    this.watchdog.unref();
  }
  view() {
    return {
      version: OBSERVER_VERSION,
      active: this.owner !== undefined,
      health: this.health(),
      failed: this.failed,
      ...(this.terminal ? { terminal: this.terminal } : {}),
    };
  }
  private serialize(action: () => Promise<void>) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  start(executable: string, endpoint: string, password: string, job?: string) {
    return this.serialize(async () => {
      if (this.closing) throw new Error('observer_workspace_closed');
      await this.stopCurrent();
      const options = await this.launch(executable);
      this.generationBase += this.current.getHealth().generation + 1;
      this.owner = startObserverProcess({
        ...options,
        ...(job ? { job } : {}),
        endpoint,
        password,
      });
      this.terminal = undefined;
      this.failed = false;
      this.launched = true;
      const owner = this.owner;
      void owner.closed
        .then(() =>
          this.serialize(async () => {
            if (this.owner === owner) await this.stopCurrent();
          }),
        )
        .catch(() => console.error('observer_workspace_finalization_failed'));
      this.current = this.owner.source;
      this.lease = performance.now();
      this.unsubscribe = [
        this.current.subscribe(() => this.listeners.forEach((f) => f())),
        this.current.subscribeLiveGameEvents((event) =>
          this.events.forEach((f) => f(this.event(event))),
        ),
      ];
      this.listeners.forEach((f) => f());
    });
  }
  pulse() {
    this.lease = performance.now();
  }
  stop() {
    return this.serialize(() => this.stopCurrent());
  }
  private async stopCurrent() {
    const owner = this.owner;
    if (!owner) {
      if (!this.launched) await this.current.stop();
      return;
    }
    const stopped = await owner.stop();
    if (!stopped.exited) throw new Error('observer_process_stop_timeout');
    const result = await owner.closed;
    this.terminal = result.terminal;
    this.failed = result.failed;
    this.owner = undefined;
    this.unsubscribe.forEach((f) => f());
    this.unsubscribe = [];
    this.listeners.forEach((f) => f());
    if (
      result.terminal.report === 'received' &&
      (result.terminal.cleanupCompleted === false ||
        result.terminal.finalizationFailures.length > 0)
    )
      throw new Error('observer_component_finalization_failed');
  }
  close() {
    this.closing = true;
    clearInterval(this.watchdog);
    return this.stop();
  }
}

/** Resolve the pinned component inside the verified product and the selected CS2 installation. */
export function installedWorkspaceObserver(
  root: string,
  state: string,
  launcher: string,
  job: string,
  initialSource?: CstvSourceManager<'lookahead'>,
) {
  return new WorkspaceObserver(async (executable) => {
    const component = join(root, 'resources/observer');
    const manifest = z
      .object({
        componentVersion: z.string(),
        sourceSha: z.string(),
        distribution: z.string(),
        entrypoints: z.strictObject({
          python: z.literal('runtime/python/python.exe'),
          driver: z.literal('client/driver.py'),
          native: z.literal('client/cs2_observer.dll'),
          worker: z.literal('client/parser_worker.mjs'),
        }),
        filesSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
      })
      .parse(JSON.parse(await readFile(join(component, 'manifest.json'), 'utf8')) as unknown);
    if (
      manifest.componentVersion !== OBSERVER_VERSION ||
      manifest.sourceSha !== SOURCE_SHA ||
      manifest.distribution !== 'external-node'
    )
      throw new Error('observer_component_version');
    for (const entry of Object.values(manifest.entrypoints)) {
      if (
        ![
          'runtime/python/python.exe',
          'client/driver.py',
          'client/cs2_observer.dll',
          'client/parser_worker.mjs',
        ].includes(entry)
      )
        throw new Error('observer_component_entrypoint');
      const path = join(component, entry);
      if (
        (await lstat(path)).isSymbolicLink() ||
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== manifest.filesSha256[entry]
      )
        throw new Error('observer_component_hash');
    }
    const game = resolve(dirname(executable), '../..');
    const info = await readFile(join(game, 'csgo/steam.inf'), 'utf8');
    const patch = /^PatchVersion=(\d+(?:\.\d+){1,4})\s*$/m.exec(info)?.[1];
    if (!patch) throw new Error('observer_host_version');
    return {
      role: 'lookahead',
      python: join(component, 'runtime/python/python.exe'),
      driver: join(component, 'client/driver.py'),
      native: join(component, 'client/cs2_observer.dll'),
      parserWorker: join(component, 'client/parser_worker.mjs'),
      node: process.execPath,
      steamApi: join(dirname(executable), 'steam_api64.dll'),
      hostVersion: Number(patch.replaceAll('.', '')),
      outputDirectory: join(state, 'data/observer', randomUUID()),
      launcher,
      job,
    };
  }, initialSource);
}

export function registerWorkspaceObserver(
  app: FastifyInstance,
  observer: WorkspaceObserver,
  token: string,
  canStart: () => boolean = () => true,
  settings?: ObserverSettingsStore,
) {
  let configured = '';
  app.get('/local/v1/observer', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(observer.view()),
  );
  const command = z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('prepare'),
      useMulnx: z.boolean().default(false),
      game: z.string().max(80),
      job: z.string().max(100),
    }),
    z.strictObject({
      action: z.literal('start-configured'),
      useMulnx: z.boolean().default(false),
      executable: z.string().max(2048),
      job: z.string().max(100),
      game: z.string().max(80),
      revision: z.uuid(),
      hudOriginal: z.union([z.literal(0), z.literal(1)]).optional(),
    }),
    z.strictObject({
      action: z.literal('start'),
      executable: z.string().max(2048),
      job: z.string().regex(/^Local\\MizarObserver-[a-zA-Z0-9-]+$/),
      endpoint: z.string().max(100),
      password: z.string().max(95),
    }),
    z.strictObject({ action: z.enum(['stop', 'pulse']) }),
  ]);
  app.post('/operator/runtime/observer', { bodyLimit: 4096 }, async (request, reply) => {
    const actual = Buffer.from(
      typeof request.headers['x-runtime-token'] === 'string'
        ? request.headers['x-runtime-token']
        : '',
    );
    const expected = Buffer.from(token);
    if (
      request.headers.origin !== undefined ||
      !expected.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    const parsed = command.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'observer_command_invalid' });
    try {
      const body = parsed.data;
      if (['start', 'start-configured', 'prepare'].includes(body.action) && !canStart())
        return reply.code(409).send({ message: '请进入正式制播工作台后连接早源。' });
      if (body.action === 'prepare') {
        const gameControl = body.useMulnx && settings?.gameAutomation;
        if (
          !settings ||
          !(
            settings.settings.enabled ||
            (gameControl && (gameControl.autoConnect || gameControl.hideGameHud))
          )
        )
          return { ok: true, enabled: false };
        const connection = settings.configured();
        if (!connection && (settings.settings.enabled || (gameControl && gameControl.autoConnect)))
          return reply.code(409).send({ message: '请在准备中心填写本场授权的观战连接。' });
        return {
          ok: true,
          enabled: true,
          revision: settings.revision,
          hideGameHud: Boolean(gameControl && gameControl.hideGameHud),
          reuse:
            (!settings.settings.enabled || observer.view().active) &&
            configured === [body.game, body.job, settings.revision, body.useMulnx].join(':'),
          connection: connection
            ? {
                earlyEndpoint: connection.earlyEndpoint,
                programEndpoint: connection.programEndpoint,
              }
            : null,
        };
      }
      if (body.action === 'start-configured') {
        if (!settings) return { ok: true, enabled: false };
        const connection = settings.configured();
        const gameControl = body.useMulnx ? settings.gameAutomation : null;
        const observerEnabled = settings.settings.enabled;
        if (!(
          observerEnabled ||
          (gameControl && (gameControl.autoConnect || gameControl.hideGameHud))
        ))
          return { ok: true, enabled: false };
        if (
          settings.revision !== body.revision ||
          (!connection && (observerEnabled || gameControl?.autoConnect))
        )
          throw new Error('observer_configuration_changed');
        if (gameControl?.hideGameHud && body.hudOriginal === undefined)
          throw new Error('observer_hud_snapshot_required');
        const current = () => settings.revision === body.revision && canStart();
        await observer.stop();
        if (!current()) throw new Error('observer_configuration_changed');
        if (gameControl?.autoConnect && connection)
          await sendObserverGameCommand(
            observerConnectCommand(connection, gameControl.hideGameHud),
          );
        else if (gameControl?.hideGameHud)
          await sendObserverGameCommand('cl_draw_only_deathnotices 1');
        if (!current()) throw new Error('observer_configuration_changed');
        if (observerEnabled && connection) {
          await observer.start(
            body.executable,
            connection.earlyEndpoint,
            connection.password,
            body.job,
          );
          if (!current()) {
            await observer.stop();
            throw new Error('observer_configuration_changed');
          }
        }
        configured = [body.game, body.job, body.revision, body.useMulnx].join(':');
        return { ok: true, enabled: true, ...observer.view() };
      }
      if (body.action === 'start')
        await observer.start(body.executable, body.endpoint, body.password, body.job);
      else if (body.action === 'stop') {
        configured = '';
        await observer.stop();
      } else observer.pulse();
      return { ok: true, enabled: true, ...observer.view() };
    } catch (error) {
      request.log.error(
        {
          stage: 'observer_workspace',
          err: error,
        },
        '观察辅助操作需要重试',
      );
      return reply
        .code(409)
        .send({ message: '请核对本场观战连接和所选启动方式的组件状态；详细阶段见运行诊断。' });
    }
  });
}
