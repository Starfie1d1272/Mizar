import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, dirname, join } from 'node:path';
import { isIP } from 'node:net';
import type { GameEventSourceRole } from '@mizar/core/game-events';
import {
  createObserverSourceManager,
  type CstvSourceManager,
  type ObserverSourceManager,
} from './cstv-source-manager.js';
import { consumeObserverOutput } from './observer-output.js';

/** Runtime paths come from the local installed artifact owner, never match metadata. */
export interface ObserverProcessOptions<R extends GameEventSourceRole> {
  readonly role: R;
  readonly python: string;
  readonly driver: string;
  readonly native: string;
  readonly steamApi: string;
  readonly node: string;
  readonly parserWorker: string;
  readonly outputDirectory: string;
  readonly hostVersion: number;
  readonly endpoint: string;
  readonly password: string;
  readonly seconds?: number;
  readonly onAttempt?: (evidence: ObserverAttemptEvidence) => void;
  readonly launcher?: string;
  readonly job?: string;
}

export interface ObserverAttemptEvidence {
  readonly attemptId: string;
  readonly attemptCount: number;
  readonly stage: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawnCode?: string | undefined;
  readonly errnoCode?: string | undefined;
  readonly ready: boolean;
  readonly startupTimedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: { status: 'ended' | 'cancelled' | 'failed'; parsedRecords: number };
  readonly report: 'received' | 'missing' | 'invalid' | 'over-budget';
  readonly reason?: string | undefined;
  readonly outcome?: 'failed' | 'incomplete' | 'closed' | undefined;
  readonly phase?: string | undefined;
  readonly nativeBootCode?: number | undefined;
  readonly steamInitResult?: number | undefined;
  readonly remoteEndReason?: number | undefined;
  readonly drainCompleted?: boolean | undefined;
  readonly cleanupCompleted?: boolean | undefined;
  readonly finalizationFailures: readonly string[];
}

/** Keep stable terminal evidence, never arbitrary child text or configuration. */
function terminalEvidence(bytes: Buffer, overflow: boolean) {
  if (overflow) return { report: 'over-budget' as const };
  const text = bytes.toString('utf8').trim();
  if (!text) return { report: 'missing' as const };
  const preReport = [
    'output-directory-unavailable',
    'configuration-boundary',
    'node-runtime-probe-invalid',
    'node-runtime-version-invalid',
    'node-runtime-requires-24-or-newer',
    'node-runtime-capabilities-missing',
    'node-runtime-not-found',
    'node-runtime-probe-failed',
  ];
  const token = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^ValueError: /, ''))
    .find((line) => preReport.includes(line));
  const absentReport = () =>
    token ? { report: 'missing' as const, reason: token } : { report: 'invalid' as const };
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8').trim().split(/\r?\n/).at(-1) ?? '');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return absentReport();
    const row = value as Record<string, unknown>;
    if (
      !(
        row.online_success === 'INCONCLUSIVE' ||
        (row.schema === 'cs2-observer-report/1' &&
          typeof row.reachedFull === 'boolean' &&
          typeof row.drainCompleted === 'boolean' &&
          typeof row.cleanupCompleted === 'boolean')
      ) ||
      !['failed', 'incomplete', 'closed'].includes(String(row.outcome))
    )
      return absentReport();
    const reasons = [
      'owner-stopped',
      'duration-limit-incomplete',
      'native-start-failed',
      'operation-failed-details-omitted',
      'interrupted',
      'addon-initialization-required',
      'new-string-table-callbacks-required',
      'prespawn-initialization-required',
      'initialization-timeout',
      'phase-timeout',
      'native-session-closed',
      'source-hltv-stop',
      'source-drain-timeout',
      'source-drain-native-failed',
      'output-backpressure',
      'output-closed',
      'configuration-boundary',
      'ordered-parser-exited',
      'ordered-parser-not-running',
      'ordered-parser-protocol-version',
      'ordered-parser-identity',
      'ordered-parser-creation-sequence',
      'ordered-parser-checkpoint-order',
      'ordered-parser-checkpoint-shape',
      'ordered-parser-input-backpressure',
      'spawn-before-parser-initialization',
      'receipt-before-parser-checkpoint',
    ];
    const integer = (v: unknown) =>
      typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
    return {
      report: 'received' as const,
      phase:
        typeof row.phase === 'string' &&
        [
          'transport',
          'challenge',
          'ticket',
          'connection',
          'channel',
          'draining',
          'closed',
          'blocked',
        ].includes(row.phase)
          ? row.phase
          : undefined,
      outcome: row.outcome as 'failed' | 'incomplete' | 'closed',
      reason:
        typeof row.reason === 'string' &&
        /^(?:ordered-parser-error|ordered-parser-input-failed|ordered-parser-output-failed|ordered-parser-world-reinitialization): /.test(
          row.reason,
        )
          ? 'ordered-parser-error-details-omitted'
          : typeof row.reason === 'string' && reasons.includes(row.reason)
            ? row.reason
            : 'unclassified',
      nativeBootCode: integer(row.native_boot_code),
      steamInitResult: integer(row.steam_init_result),
      remoteEndReason: integer(row.remote_end_reason),
      drainCompleted: typeof row.drainCompleted === 'boolean' ? row.drainCompleted : undefined,
      cleanupCompleted:
        typeof row.cleanupCompleted === 'boolean' ? row.cleanupCompleted : undefined,
      finalizationFailures: Array.isArray(row.finalization_failures)
        ? row.finalization_failures
            .filter(
              (v): v is string =>
                typeof v === 'string' &&
                [
                  'close-session',
                  'close-parser',
                  'close-events',
                  'close-samples',
                  'close-output',
                  'close-input',
                  'write-report',
                ].includes(v),
            )
            .slice(0, 8)
        : [],
    };
  } catch {
    return absentReport();
  }
}

/** Explicit composition only. Importing this module never starts Steam or a process. */
export function startObserverProcess<R extends GameEventSourceRole>(
  options: ObserverProcessOptions<R>,
) {
  return startReconnectingObserverProcess(options);
}

function startObserverAttempt<R extends GameEventSourceRole>(
  options: ObserverProcessOptions<R>,
  existingManager?: ObserverSourceManager<R>,
  keepManager = false,
) {
  const colon = options.endpoint.lastIndexOf(':');
  const host = options.endpoint.slice(0, colon).replace(/^\[|\]$/g, '');
  const port = options.endpoint.slice(colon + 1);
  const seconds = options.seconds;
  if (
    colon < 1 ||
    isIP(host) === 0 ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    options.password.length > 95 ||
    !Array.from(options.password).every(
      (char) => char.charCodeAt(0) > 0 && char.charCodeAt(0) <= 127,
    ) ||
    !Number.isInteger(options.hostVersion) ||
    options.hostVersion < 1 ||
    options.hostVersion > 0xffffffff ||
    (options.launcher !== undefined &&
      (!isAbsolute(options.launcher) ||
        !/^Local\\MizarObserver-[a-zA-Z0-9-]+$/.test(options.job ?? ''))) ||
    (seconds !== undefined && (!Number.isSafeInteger(seconds) || seconds < 1)) ||
    ![
      options.python,
      options.driver,
      options.native,
      options.steamApi,
      options.node,
      options.parserWorker,
      options.outputDirectory,
    ].every(isAbsolute) ||
    (process.env.SteamAppId !== undefined && process.env.SteamAppId !== '730')
  ) {
    throw new Error('Invalid observer launch configuration');
  }
  const role = options.role === 'lookahead' ? 'ahead' : 'delayed';
  const sourceId = randomUUID().replaceAll('-', '');
  const identity = { source: `${role}:${sourceId}`, role, channel: 1, world: 1 } as const;
  const manager =
    existingManager ??
    createObserverSourceManager({
      role: options.role,
      identity,
    });
  if (existingManager !== undefined) manager.attachObserver(identity);
  const env: NodeJS.ProcessEnv = { SteamAppId: '730' };
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOME',
    'XDG_RUNTIME_DIR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const args = [
    options.driver,
    '--managed',
    '--native',
    options.native,
    '--steam-api',
    options.steamApi,
    '--node',
    options.node,
    '--parser-worker',
    options.parserWorker,
    '--source-role',
    role,
    '--source-id',
    sourceId,
    '--host-version',
    String(options.hostVersion),
    ...(seconds === undefined ? [] : ['--seconds', String(seconds)]),
    '--output',
    options.outputDirectory,
  ];
  const child = spawn(
    options.launcher ?? options.python,
    options.launcher ? ['--observer-process', options.job!, options.python, ...args] : args,
    {
      cwd: dirname(options.driver),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const attemptId = randomUUID();
  let spawnCode: string | undefined;
  let exitSignal: string | null = null;
  let ready = false;
  let startupTimedOut = false;
  const startupTimer = setTimeout(() => {
    startupTimedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  const unsubscribe = manager.subscribe(() => {
    if (manager.getHealth().state === 'live') {
      ready = true;
      clearTimeout(startupTimer);
    }
  });
  manager.start();
  let exited = false;
  let inputFailed = false;
  let stoppingRequested = false;
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'ENOMEM', 'EAGAIN'].includes(
        error.code ?? '',
      )
        ? error.code
        : 'unclassified';
      inputFailed = true;
      child.stdout.destroy();
    });
    child.once('close', (code, signal) => {
      exitSignal = signal;
      exited = true;
      resolve(code);
    });
  });
  // Neither raw stderr nor connection configuration is retained in application diagnostics.
  let stderr = Buffer.alloc(0);
  let stderrOverflow = false;
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrOverflow) return;
    if (stderr.length + chunk.length > 64 * 1024) {
      stderr.fill(0);
      stderr = Buffer.alloc(0);
      stderrOverflow = true;
      return;
    }
    const next = Buffer.concat([stderr, chunk]);
    stderr.fill(0);
    stderr = next;
  });
  const configuration = Buffer.from(
    JSON.stringify({ endpoint: options.endpoint, password: options.password }) + '\n',
  );
  child.stdin.on('error', () => {
    configuration.fill(0);
    inputFailed = true;
    child.stdout.destroy();
    child.kill();
  });
  child.stdin.write(configuration, () => configuration.fill(0));
  const reading = consumeObserverOutput(child.stdout, manager).then((output) => {
    if (output.status === 'failed' && !exited) child.kill('SIGKILL');
    return output;
  });
  const closed = Promise.all([exit, reading]).then(([code, output]) => {
    unsubscribe();
    clearTimeout(startupTimer);
    const report = terminalEvidence(stderr, stderrOverflow);
    const reason = 'reason' in report ? report.reason : undefined;
    const stage = spawnCode
      ? 'spawn'
      : reason === 'output-directory-unavailable'
        ? 'output-directory'
        : reason === 'configuration-boundary'
          ? 'configuration'
          : reason?.startsWith('node-runtime-')
            ? 'node-probe'
            : report.report === 'received' &&
                (report.cleanupCompleted === false || report.finalizationFailures.length > 0)
              ? 'cleanup'
              : reason === 'native-start-failed'
                ? 'native-boot'
                : reason?.startsWith('ordered-parser-') ||
                    reason?.includes('parser-initialization') ||
                    reason === 'receipt-before-parser-checkpoint'
                  ? ready
                    ? 'parser-runtime'
                    : 'parser-initialization'
                  : output.status === 'failed'
                    ? 'stdout-protocol'
                    : startupTimedOut
                      ? 'readiness-timeout'
                      : stoppingRequested
                        ? 'cancelled'
                        : report.report === 'received' && report.phase
                          ? report.phase
                          : reason === 'operation-failed-details-omitted'
                            ? 'component-initialization'
                            : report.report === 'received'
                              ? 'session'
                              : 'eof';
    const terminal: ObserverAttemptEvidence = {
      ...report,
      attemptId,
      attemptCount: 1,
      stage,
      code,
      signal: exitSignal,
      ...(spawnCode ? { spawnCode } : {}),
      ready,
      startupTimedOut,
      cancelled: stoppingRequested,
      stdout: output,
      finalizationFailures: report.report === 'received' ? report.finalizationFailures : [],
    };
    stderr.fill(0);
    stderr = Buffer.alloc(0);
    return {
      terminal,
      code,
      output,
      ready,
      startupTimedOut,
      cancelled: stoppingRequested,
      failed:
        (terminal.report === 'received' &&
          (terminal.outcome === 'failed' ||
            terminal.cleanupCompleted === false ||
            (terminal.outcome === 'closed' && terminal.drainCompleted === false))) ||
        (!stoppingRequested &&
          (!ready ||
            inputFailed ||
            (code !== 2 &&
              !(
                code === 0 &&
                terminal.report === 'received' &&
                terminal.outcome === 'closed' &&
                terminal.reason === 'source-hltv-stop' &&
                terminal.remoteEndReason === 1038
              )) ||
            output.status === 'failed')),
    };
  });
  let stopping: Promise<{ exited: boolean }> | undefined;
  const waitForExit = async (timeout = 1500): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  };
  const owner = {
    manager,
    closed,
    stop(): Promise<{ exited: boolean }> {
      stopping ??= (async () => {
        stoppingRequested = true;
        clearTimeout(startupTimer);
        if (keepManager) manager.disconnectObserver();
        else await manager.stop();
        if (!exited) child.stdin.end();
        // Allow the component's bounded parser/output finalizers to finish first.
        await waitForExit(12_000);
        if (!exited) {
          child.kill('SIGTERM');
          await waitForExit();
        }
        if (!exited) {
          child.kill('SIGKILL');
          await waitForExit();
        }
        return { exited };
      })();
      return stopping;
    },
  };
  // Companion's existing shutdown contract calls source.stop(), not an extra
  // transport-owner hook. Keep the same data owner while joining child cleanup.
  const source: CstvSourceManager<R> = {
    role: manager.role,
    start: () => manager.start(),
    stop: async () => {
      const result = await owner.stop();
      if (!result.exited) throw new Error('Observer process did not exit');
      const terminal = await owner.closed;
      if (terminal.failed)
        throw new Error('Observer process ended with failure', { cause: terminal.terminal });
    },
    getHealth: () => manager.getHealth(),
    getRecentGameEvents: () => manager.getRecentGameEvents(),
    getRecentDiagnostics: () => manager.getRecentDiagnostics(),
    getSnapshot: () => manager.getSnapshot(),
    subscribe: (listener) => manager.subscribe(listener),
    subscribeLiveGameEvents: (listener) => manager.subscribeLiveGameEvents(listener),
  };
  return { ...owner, source };
}

/** Reconnect the configured authorized source; each child gets a fresh identity. */
function startReconnectingObserverProcess<R extends GameEventSourceRole>(
  options: ObserverProcessOptions<R>,
) {
  let current = startObserverAttempt(options, undefined, true);
  const manager = current.manager;
  let stopped = false;
  let attemptCount = 1;
  const attempts: ObserverAttemptEvidence[] = [];
  let wake: (() => void) | undefined;
  const closed = (async () => {
    while (true) {
      const result = await current.closed;
      const evidence = { ...result.terminal, attemptCount };
      attempts.push(evidence);
      if (attempts.length > 8) attempts.shift();
      options.onAttempt?.(evidence);
      const summary = { ...result, terminal: evidence, attempts: [...attempts] };
      const cleanup = await current.stop();
      const cleanupFailed =
        !cleanup.exited ||
        (result.terminal.report === 'received' && result.terminal.finalizationFailures.length > 0);
      if (stopped) return { ...summary, attemptCount, cancelled: true, failed: cleanupFailed };
      const terminal = result.terminal;
      const retry =
        !cleanupFailed &&
        (result.startupTimedOut ||
          (terminal.report === 'received' &&
            terminal.outcome === 'failed' &&
            (terminal.reason === 'initialization-timeout' ||
              terminal.reason === 'phase-timeout' ||
              (terminal.reason === 'native-session-closed' &&
                (terminal.remoteEndReason === 0 || terminal.remoteEndReason === 1000)))));
      if (!retry) {
        await manager.stop();
        return { ...summary, attemptCount, failed: result.failed || cleanupFailed };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.min(15_000, 1000 * 2 ** Math.min(attemptCount - 1, 4)),
        );
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      if (stopped) return { ...summary, attemptCount, cancelled: true, failed: cleanupFailed };
      attemptCount += 1;
      current = startObserverAttempt(
        { ...options, outputDirectory: join(options.outputDirectory, `retry-${attemptCount}`) },
        manager,
        true,
      );
    }
  })();
  let stopping: Promise<{ exited: boolean }> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      stopped = true;
      wake?.();
      const result = await current.stop();
      await closed;
      await manager.stop();
      return result;
    })());
  const source: CstvSourceManager<R> = {
    ...current.source,
    stop: async () => {
      const result = await stop();
      const terminal = await closed;
      if (!result.exited || terminal.failed)
        throw new Error('Observer source did not stop cleanly');
    },
  };
  return { manager, source, closed, stop, attempts: () => [...attempts] };
}
