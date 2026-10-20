import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';
import { isIP } from 'node:net';
import type { GameEventSourceRole } from '@mizar/core/game-events';
import { createObserverSourceManager, type CstvSourceManager } from './cstv-source-manager.js';
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
}

/** Keep stable terminal evidence, never arbitrary child text or configuration. */
function terminalEvidence(bytes: Buffer, overflow: boolean) {
  if (overflow) return { report: 'over-budget' as const };
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { report: 'unavailable' as const };
    const row = value as Record<string, unknown>;
    if (
      row.online_success !== 'INCONCLUSIVE' ||
      !['failed', 'incomplete'].includes(String(row.outcome))
    )
      return { report: 'unavailable' as const };
    const reasons = [
      'owner-stopped',
      'duration-limit-incomplete',
      'native-start-failed',
      'operation-failed-details-omitted',
      'interrupted',
      'addon-initialization-required',
      'new-string-table-callbacks-required',
      'prespawn-initialization-required',
    ];
    const integer = (v: unknown) =>
      typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
    return {
      report: 'received' as const,
      outcome: row.outcome as 'failed' | 'incomplete',
      reason:
        typeof row.reason === 'string' && reasons.includes(row.reason)
          ? row.reason
          : 'unclassified',
      nativeBootCode: integer(row.native_boot_code),
      steamInitResult: integer(row.steam_init_result),
      remoteEndReason: integer(row.remote_end_reason),
      finalizationFailures: Array.isArray(row.finalization_failures)
        ? row.finalization_failures.filter(
            (v): v is string =>
              typeof v === 'string' &&
              [
                'close-session',
                'close-parser',
                'close-events',
                'close-samples',
                'write-report',
              ].includes(v),
          )
        : [],
    };
  } catch {
    return { report: 'unavailable' as const };
  }
}

/** Explicit composition only. Importing this module never starts Steam or a process. */
export function startObserverProcess<R extends GameEventSourceRole>(
  options: ObserverProcessOptions<R>,
) {
  const colon = options.endpoint.lastIndexOf(':');
  const host = options.endpoint.slice(0, colon).replace(/^\[|\]$/g, '');
  const port = options.endpoint.slice(colon + 1);
  const seconds = options.seconds ?? 14_400;
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
    options.hostVersion !== 14191 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 14_400 ||
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
  const manager = createObserverSourceManager({
    role: options.role,
    identity: { source: `${role}:${sourceId}`, role, channel: 1, world: 1 },
  });
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
    '--seconds',
    String(seconds),
    '--output',
    options.outputDirectory,
  ];
  const child = spawn(options.python, args, {
    cwd: dirname(options.driver),
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    child.once('error', () => {
      inputFailed = true;
      child.stdout.destroy();
    });
    child.once('close', (code) => {
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
    const terminal = terminalEvidence(stderr, stderrOverflow);
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
        (terminal.report === 'received' && terminal.outcome === 'failed') ||
        (!stoppingRequested && (!ready || inputFailed || code !== 2 || output.status === 'failed')),
    };
  });
  let stopping: Promise<{ exited: boolean }> | undefined;
  const waitForExit = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
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
        await manager.stop();
        if (!exited) child.stdin.end();
        await waitForExit();
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
