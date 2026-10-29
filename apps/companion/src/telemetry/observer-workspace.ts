import { readFile, lstat, mkdir, access } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { safePath } from '../resource-store/files.js';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCstvSourceManager, type CstvSourceManager } from './cstv-source-manager.js';
import {
  startObserverProcess,
  type ObserverProcessOptions,
  type ObserverAttemptEvidence,
} from './observer-process.js';
import type { ObserverSettingsStore } from './observer-settings.js';
import { sendObserverGameCommand, observerConnectCommand } from './observer-game-control.js';
import { MatchNameSync, matchNames } from './match-names.js';
import type { MatchContextBinding } from '../match-context/lkg-store.js';
import observerComponent from './observer-component.json' with { type: 'json' };

export const OBSERVER_VERSION = observerComponent.version;
/** Create only controlled ancestors; the pinned driver owns the unique final directory. */
export async function prepareObserverOutputParent(state: string): Promise<string> {
  await safePath(state);
  let parent = state;
  for (const name of ['data', 'observer']) {
    await safePath(parent);
    parent = join(parent, name);
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await safePath(parent);
  }
  await access(parent, constants.W_OK | constants.X_OK);
  return parent;
}
class ObserverPreparationError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
    readonly errnoCode?: string,
  ) {
    super(reason);
  }
}
type ObserverHistory = ObserverAttemptEvidence & { sessionId: string };
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
  private intent = 0;
  private readonly history: ObserverHistory[] = [];
  private sessionId: string | undefined;
  private evidenceListeners = new Set<(evidence: ObserverHistory) => void>();
  subscribeEvidence(listener: (evidence: ObserverHistory) => void) {
    this.evidenceListeners.add(listener);
    return () => {
      this.evidenceListeners.delete(listener);
    };
  }
  private retain(evidence: ObserverAttemptEvidence, sessionId: string) {
    const entry = { ...evidence, sessionId };
    this.history.push(entry);
    if (this.history.length > 8) this.history.shift();
    this.evidenceListeners.forEach((listener) => {
      try {
        listener(entry);
      } catch {
        console.error('observer_workspace_diagnostic_failed');
      }
    });
  }
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
      sessionId: this.sessionId,
      history: [...this.history],
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
  start(
    executable: string,
    endpoint: string,
    password: string,
    job?: string,
    current: () => boolean = () => true,
  ) {
    const intent = ++this.intent;
    const check = () => {
      if (this.closing || intent !== this.intent || !current())
        throw new Error('observer_configuration_changed');
    };
    return this.serialize(async () => {
      check();
      await this.stopCurrent();
      check();
      this.terminal = undefined;
      this.failed = false;
      const sessionId = (this.sessionId = randomUUID());
      let options: Awaited<ReturnType<typeof this.launch>>;
      try {
        options = await this.launch(executable);
        check();
        this.generationBase += this.current.getHealth().generation + 1;
        this.owner = startObserverProcess({
          ...options,
          ...(job ? { job } : {}),
          endpoint,
          password,
          onAttempt: (evidence) => this.retain(evidence, sessionId),
        });
      } catch (error) {
        const cancelled = this.closing || intent !== this.intent || !current();
        this.terminal = {
          attemptId: randomUUID(),
          attemptCount: 0,
          stage: cancelled
            ? 'cancelled'
            : error instanceof ObserverPreparationError
              ? error.stage
              : 'preparation',
          reason: cancelled
            ? 'configuration-changed'
            : error instanceof ObserverPreparationError
              ? error.reason
              : 'preparation-failed',
          ...(error instanceof ObserverPreparationError && error.errnoCode
            ? { errnoCode: error.errnoCode }
            : {}),
          report: 'missing',
          code: null,
          signal: null,
          ready: false,
          startupTimedOut: false,
          cancelled,
          stdout: { status: 'ended', parsedRecords: 0 },
          finalizationFailures: [],
        };
        this.failed = !cancelled;
        this.retain(this.terminal, sessionId);
        this.listeners.forEach((f) => f());
        throw error;
      }
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
    ++this.intent;
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
    let stage = 'component-verification';
    try {
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
        manifest.sourceSha !== observerComponent.sourceSha ||
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
      stage = 'host-version';
      const game = resolve(dirname(executable), '../..');
      const info = await readFile(join(game, 'csgo/steam.inf'), 'utf8');
      const patch = /^PatchVersion=(\d+(?:\.\d+){1,4})\s*$/m.exec(info)?.[1];
      if (!patch) throw new Error('observer_host_version');
      stage = 'output-parent';
      const outputParent = await prepareObserverOutputParent(state);
      return {
        role: 'lookahead',
        python: join(component, 'runtime/python/python.exe'),
        driver: join(component, 'client/driver.py'),
        native: join(component, 'client/cs2_observer.dll'),
        parserWorker: join(component, 'client/parser_worker.mjs'),
        node: process.execPath,
        steamApi: join(dirname(executable), 'steam_api64.dll'),
        hostVersion: Number(patch.replaceAll('.', '')),
        outputDirectory: join(outputParent, randomUUID()),
        launcher,
        job,
      };
    } catch (error) {
      const nativeCode = (error as NodeJS.ErrnoException)?.code;
      const code = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EROFS', 'ELOOP', 'ENOSPC'].includes(
        nativeCode ?? '',
      )
        ? nativeCode
        : undefined;
      const reason =
        error instanceof Error &&
        [
          'observer_component_version',
          'observer_component_entrypoint',
          'observer_component_hash',
          'observer_host_version',
        ].includes(error.message)
          ? error.message
          : stage === 'output-parent'
            ? 'output-parent-unavailable'
            : 'preparation-failed';
      throw new ObserverPreparationError(stage, reason, code);
    }
  }, initialSource);
}

export function registerWorkspaceObserver(
  app: FastifyInstance,
  observer: WorkspaceObserver,
  token: string,
  canStart: () => boolean = () => true,
  settings?: ObserverSettingsStore,
  binding?: () => MatchContextBinding | undefined,
) {
  type Host = {
    game: string;
    job: string;
    executable: string;
    useMulnx: boolean;
    nativeHudToggle: boolean;
  };
  let host: Host | undefined;
  let hostLease = 0;
  let prepared: { identity: string; settingsRevision: string; token: string } | undefined;
  let observerKey = '';
  let connectedGame = '';
  let seamlessGame = '';
  let hiddenGame = '';
  let appliedPolicy = '';
  let epoch = 0;
  let pending = 0;
  let lastError: 'observer_operation_failed' | null = null;
  let queue = Promise.resolve();
  const serialize = (action: () => Promise<void>) => {
    ++pending;
    const next = queue.then(action).finally(() => {
      --pending;
    });
    queue = next.catch(() => {});
    return next;
  };
  const identity = (value: {
    game: string;
    job: string;
    useMulnx: boolean;
    nativeHudToggle: boolean;
  }) => JSON.stringify([value.game, value.job, value.useMulnx, value.nativeHudToggle]);
  const policy = (value: {
    game: string;
    job: string;
    useMulnx: boolean;
    nativeHudToggle: boolean;
  }) => JSON.stringify([identity(value), value.useMulnx ? settings?.gameAutomation : null]);
  const leased = () =>
    host !== undefined &&
    (!prepared || prepared.identity === identity(host)) &&
    performance.now() - hostLease <= 6000;
  const names = new MatchNameSync(() => ({
    session: leased() && host?.useMulnx ? JSON.stringify([host.game, host.job]) : null,
    names:
      canStart() && settings?.settings.nicknameSource === 'website'
        ? matchNames(binding?.())
        : new Map<string, string>(),
  }));
  const namesTimer = setInterval(() => {
    void names.tick().catch(() => app.log.error({ stage: 'match_names' }, '游戏昵称同步失败'));
  }, 1000);
  namesTimer.unref();
  const keys = (value: Host) => {
    const connection = settings?.configured();
    const game = JSON.stringify([value.game, value.job]);
    return {
      game,
      observer: JSON.stringify([
        game,
        value.executable,
        connection?.earlyEndpoint,
        connection?.password,
      ]),
      connect: JSON.stringify([
        game,
        connection?.programEndpoint,
        connection?.password,
        settings?.mapConnection?.id,
      ]),
      hud: game,
    };
  };
  const startAssist = async (value: Host, current: () => boolean) => {
    const connection = settings?.configured();
    if (!settings?.settings.enabled || !connection) return;
    const key = keys(value).observer;
    if (observerKey === key && observer.view().active) return;
    await observer.stop();
    if (!current()) throw new Error('observer_configuration_changed');
    await observer.start(
      value.executable,
      connection.earlyEndpoint,
      connection.password,
      value.job,
      current,
    );
    if (!current()) {
      await observer.stop();
      throw new Error('observer_configuration_changed');
    }
    observerKey = key;
  };
  const unsubscribe = settings?.subscribe((kind) => {
    if (kind === 'game' && !settings.gameAutomation.hideGameHud) hiddenGame = '';
    if (kind === 'settings' || kind === 'lead' || kind === 'name' || kind === 'game') return;
    const attempt = ++epoch;
    if (kind === 'map')
      seamlessGame = settings.mapConnection?.mode === 'seamless' && host ? keys(host).game : '';
    if (kind === 'connection' || (kind === 'map' && settings.mapConnection?.mode === 'connect'))
      host = undefined;
    const value = host;
    const revision = settings.revision;
    const shouldStop =
      kind === 'connection' ||
      (kind === 'map' && settings.mapConnection?.mode === 'connect') ||
      !settings.settings.enabled;
    void serialize(async () => {
      // Stops already queued before a new preparation must finish first.
      if (shouldStop) {
        observerKey = '';
        await observer.stop();
      } else if (attempt === epoch && value && leased() && canStart()) {
        await startAssist(
          value,
          () => attempt === epoch && settings.revision === revision && leased() && canStart(),
        );
        lastError = null;
      }
    }).catch((error: unknown) => {
      lastError = 'observer_operation_failed';
      app.log.error({ stage: 'observer_settings_apply', err: error }, '观察辅助操作需要重试');
    });
  });
  app.addHook('onClose', async () => {
    clearInterval(namesTimer);
    await names.close();
    unsubscribe?.();
    ++epoch;
    host = undefined;
    await queue;
  });
  app.get('/local/v1/observer', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      ...observer.view(),
      programCommandQueued: Boolean(host && connectedGame === keys(host).connect),
      pending: pending > 0,
      error: lastError,
      retryAvailable: Boolean(
        settings?.settings.enabled && settings.configured() && canStart() && pending === 0,
      ),
    }),
  );
  const command = z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('prepare'),
      nativeHudToggle: z.boolean().default(false),
      expectedRevision: z.uuid().optional(),
      useMulnx: z.boolean().default(false),
      game: z.string().max(80),
      job: z.string().max(100),
    }),
    z.strictObject({
      action: z.literal('start-configured'),
      nativeHudToggle: z.boolean().default(false),
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
    const operation = { stage: 'preparation' as 'preparation' | 'game' | 'hud' | 'assist' };
    try {
      const body = parsed.data;
      if (['start', 'start-configured', 'prepare'].includes(body.action) && !canStart())
        return reply.code(409).send({ message: '请进入正式制播工作台后连接早源。' });
      if (body.action === 'prepare') {
        if (body.expectedRevision && body.expectedRevision !== settings?.revision)
          return reply
            .code(409)
            .send({ message: '本场连接或比赛已变化，请重新打开本场连接后确认。' });
        const gameControl = body.useMulnx && settings?.gameAutomation;
        if (
          !settings ||
          !(
            settings.settings.enabled ||
            (body.useMulnx &&
              settings.settings.nicknameSource === 'website' &&
              matchNames(binding?.()).size > 0) ||
            (gameControl &&
              (gameControl.autoConnect || (!body.nativeHudToggle && gameControl.hideGameHud)))
          )
        )
          return { ok: true, enabled: false };
        const connection = settings.configured();
        if (!connection && (settings.settings.enabled || (gameControl && gameControl.autoConnect)))
          return reply.code(409).send({ message: '请在准备中心填写本场授权的观战连接。' });
        const key = identity(body);
        if (
          !prepared ||
          prepared.identity !== key ||
          prepared.settingsRevision !== settings.revision
        ) {
          prepared = { identity: key, settingsRevision: settings.revision, token: randomUUID() };
          ++epoch;
        }
        const activeKeys = host ? keys(host) : null;
        return {
          ok: true,
          enabled: true,
          revision: prepared.token,
          hideGameHud: Boolean(!body.nativeHudToggle && gameControl && gameControl.hideGameHud),
          reuse:
            pending === 0 &&
            host !== undefined &&
            identity(host) === identity(body) &&
            activeKeys !== null &&
            appliedPolicy === policy(body) &&
            (!settings.settings.enabled ||
              (observer.view().active && observerKey === activeKeys.observer)) &&
            (!gameControl ||
              ((!gameControl.autoConnect ||
                (settings.mapConnection?.mode === 'seamless' && seamlessGame === activeKeys.game) ||
                connectedGame === activeKeys.connect) &&
                (body.nativeHudToggle ||
                  !gameControl.hideGameHud ||
                  hiddenGame === activeKeys.hud))),
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
        const revision = settings.revision;
        const attempt = epoch;
        const validPreparation = () =>
          prepared?.token === body.revision &&
          prepared.identity === identity(body) &&
          prepared.settingsRevision === revision;
        const current = () =>
          attempt === epoch && settings.revision === revision && validPreparation() && canStart();
        await serialize(async () => {
          if (!current()) throw new Error('observer_configuration_changed');
          const connection = settings.configured();
          const gameControl = body.useMulnx ? settings.gameAutomation : null;
          if (!connection && (settings.settings.enabled || gameControl?.autoConnect))
            throw new Error('observer_configuration_changed');
          const value: Host = body;
          const key = keys(value);
          if (settings.mapConnection?.mode === 'seamless' && !seamlessGame) seamlessGame = key.game;
          const connect = Boolean(
            gameControl?.autoConnect &&
            !(settings.mapConnection?.mode === 'seamless' && seamlessGame === key.game) &&
            connectedGame !== key.connect,
          );
          const hide = Boolean(
            !body.nativeHudToggle && gameControl?.hideGameHud && hiddenGame !== key.hud,
          );
          if (
            !body.nativeHudToggle &&
            gameControl?.hideGameHud &&
            (connect || hide) &&
            body.hudOriginal === undefined
          )
            throw new Error('observer_hud_snapshot_required');
          // An accepted game command is retained even if a later observer launch fails.
          // Retrying the private source must not reconnect the on-air game.
          if (connect && connection) {
            operation.stage = 'game';
            await sendObserverGameCommand(
              observerConnectCommand(
                connection,
                Boolean(!body.nativeHudToggle && gameControl?.hideGameHud),
              ),
            );
            connectedGame = key.connect;
            if (!body.nativeHudToggle && gameControl?.hideGameHud) hiddenGame = key.hud;
          } else if (hide) {
            operation.stage = 'hud';
            await sendObserverGameCommand('cl_draw_only_deathnotices 1');
            hiddenGame = key.hud;
          }
          operation.stage = 'preparation';
          if (!current()) throw new Error('observer_configuration_changed');
          host = value;
          appliedPolicy = policy(value);
          hostLease = performance.now();
          operation.stage = 'assist';
          await startAssist(value, current);
          lastError = null;
        });
      } else if (body.action === 'start') {
        operation.stage = 'assist';
        const attempt = ++epoch;
        host = undefined;
        await serialize(async () => {
          if (attempt !== epoch || !canStart()) throw new Error('observer_configuration_changed');
          await observer.start(
            body.executable,
            body.endpoint,
            body.password,
            body.job,
            () => attempt === epoch && canStart(),
          );
          observerKey = '';
          lastError = null;
        });
      } else if (body.action === 'stop') {
        ++epoch;
        host = undefined;
        prepared = undefined;
        await serialize(async () => {
          observerKey = hiddenGame = appliedPolicy = '';
          await observer.stop();
        });
      } else {
        if (leased()) hostLease = performance.now();
        else host = undefined;
        observer.pulse();
      }
      return { ok: true, enabled: true, ...observer.view() };
    } catch (error) {
      lastError = 'observer_operation_failed';
      request.log.error(
        {
          stage: 'observer_workspace',
          err: error,
        },
        '观察辅助操作需要重试',
      );
      return reply.code(409).send({
        message:
          operation.stage === 'game'
            ? '游戏观战连接未确认，请在游戏内检查连接后重试。'
            : operation.stage === 'hud'
              ? 'CS2 原生 HUD 设置未确认，请检查游戏画面后重试。'
              : operation.stage === 'assist'
                ? '观察辅助未能启动，请检查辅助设置后重试；游戏连接请在游戏内核对。'
                : '观战准备未完成，请检查游戏连接和设置后重试。',
      });
    }
  });
}
