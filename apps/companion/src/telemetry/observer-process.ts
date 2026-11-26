import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, dirname, basename } from 'node:path';
import { isIP } from 'node:net';
import { open } from 'node:fs/promises';
import { safePath } from '../resource-store/files.js';
import type { GameEventSourceRole } from '@mizar/core/game-events';
import { createObserverSourceManager, type CstvSourceManager } from './cstv-source-manager.js';
import { consumeObserverOutput } from './observer-output.js';
import { diagnosticValue } from '../support/session-journal.js';

/** Runtime paths come from the local installed artifact owner, never match metadata. */
export interface ObserverProcessOptions<R extends GameEventSourceRole> {
  readonly role: R;
  readonly executable: string;
  readonly native: string;
  readonly steamApi: string;
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
  readonly stage: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawnCode?: string | undefined;
  readonly error?: unknown;
  readonly errnoCode?: string | undefined;
  readonly ready: boolean;
  readonly startupTimedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: {
    status: 'ended' | 'cancelled' | 'failed';
    parsedRecords: number;
    error?: unknown;
  };
  readonly stderr?: {
    text: string;
    observedBytes: number;
    retainedBytes: number;
    truncated: boolean;
  };
  readonly report: 'received' | 'missing' | 'invalid' | 'over-budget';
  readonly reason?: string | undefined;
  /** Credential-redacted component reason for local diagnosis; not a public error code. */
  readonly detail?: string | undefined;
  readonly hostVersion?: number;
  readonly reportDirectory?: string;
  readonly outcome?: 'closed' | 'stopped' | 'failed' | undefined;
  readonly phase?: string | undefined;
  readonly nativeBootCode?: number | undefined;
  readonly steamInitResult?: number | undefined;
  readonly channel?: number | undefined;
  readonly world?: number | undefined;
  readonly lastOutputSequence?: number;
  readonly reconnects?: number | undefined;
  readonly supervisor?: ReturnType<typeof supervisorHealth>;
}

const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const signedInteger = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactToken(value: unknown, password: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = String(diagnosticValue(value, '', new Set(), [password]));
  return /^[a-z0-9-]{1,80}$/.test(text) ? text : undefined;
}

function supervisorHealth(input: unknown, password: string) {
  const value = object(input);
  const channel = integer(value.channel);
  const world = integer(value.world);
  if (value.type !== 'cs2-observer-health/3' || channel === undefined || world === undefined)
    return;
  const state = String(value.state);
  if (!['connecting', 'receiving', 'ended', 'failed'].includes(state)) return;
  const fault = object(value.lastFault);
  const faultReason = redactToken(fault.reason, password);
  return {
    channel,
    world,
    state: state as 'connecting' | 'receiving' | 'ended' | 'failed',
    ...(redactToken(value.reason, password) ? { reason: redactToken(value.reason, password) } : {}),
    reconnects: integer(value.reconnects),
    retryInMs: integer(value.retryInMs),
    sdkQueueAgeUs: integer(value.sdkQueueAgeUs),
    sdkMaxAgeUs: integer(value.sdkMaxAgeUs),
    decodeUs: integer(value.decodeUs),
    decodeMaxUs: integer(value.decodeMaxUs),
    committedTick: integer(value.committedTick),
    ...(faultReason
      ? {
          lastFault: {
            reason: faultReason,
            channel: integer(fault.channel),
            nativeFailure: signedInteger(fault.nativeFailure),
            remoteEndReason: signedInteger(fault.remoteEndReason),
          },
        }
      : {}),
  };
}

function v3Report(input: unknown, password: string) {
  const row = object(input);
  const supervisor =
    row.health === null || row.health === undefined
      ? undefined
      : supervisorHealth(row.health, password);
  if (
    row.schema !== 'cs2-observer-report/3' ||
    !['closed', 'stopped', 'failed'].includes(String(row.outcome)) ||
    integer(row.lastOutputSequence) === undefined ||
    typeof row.reason !== 'string' ||
    (row.health !== null && row.health !== undefined && !supervisor)
  )
    return;
  const detail = String(diagnosticValue(row.reason, '', new Set(), [password]));
  const phase =
    typeof row.phase === 'string' && /^[a-z0-9-]{1,40}$/.test(row.phase) ? row.phase : undefined;
  const nativeBootCode = signedInteger(row.nativeBootCode);
  const steamInitResult = signedInteger(row.steamInitResult);
  const channel = integer(row.channel);
  const world = integer(row.world);
  const reconnects = integer(row.reconnects);
  return {
    report: 'received' as const,
    outcome: row.outcome as 'closed' | 'stopped' | 'failed',
    reason: /^[a-z0-9-]{1,80}$/.test(detail) ? detail : 'unclassified',
    detail,
    lastOutputSequence: integer(row.lastOutputSequence)!,
    ...(channel === undefined ? {} : { channel }),
    ...(world === undefined ? {} : { world }),
    ...(reconnects === undefined ? {} : { reconnects }),
    ...(phase ? { phase } : {}),
    ...(nativeBootCode === undefined ? {} : { nativeBootCode }),
    ...(steamInitResult === undefined ? {} : { steamInitResult }),
    ...(supervisor ? { supervisor } : {}),
  };
}

/** Stderr is continuously drained. Keep a small startup excerpt and one typed report. */
function captureDiagnostics(stream: NodeJS.ReadableStream, password: string) {
  const lineBudget = 64 * 1024;
  const prefix = Buffer.alloc(4096);
  const line = Buffer.alloc(lineBudget);
  let lineBytes = 0;
  let retainedBytes = 0;
  let sawOversizeLine = false;
  let observedBytes = 0;
  let report: ReturnType<typeof v3Report>;
  let health: ReturnType<typeof supervisorHealth>;
  const consume = (complete = true) => {
    const oversized = lineBytes >= lineBudget;
    let structured = false;
    if (!oversized && lineBytes && line[0] === 123) {
      try {
        const text = line.subarray(0, lineBytes).toString('utf8');
        const row: unknown = JSON.parse(text);
        const sample = supervisorHealth(row, password);
        if (
          sample &&
          (!health ||
            sample.channel > health.channel ||
            (sample.channel === health.channel && sample.world >= health.world))
        )
          health = sample;
        const terminal = v3Report(row, password);
        if (terminal) report = terminal;
        structured = Boolean(sample || terminal);
      } catch {
        // Native noise is neither a report nor a transport error.
      }
    }
    if (!structured) {
      observedBytes += lineBytes + Number(complete);
      sawOversizeLine ||= oversized;
      const copied = Math.min(lineBytes, prefix.length - retainedBytes);
      line.copy(prefix, retainedBytes, 0, copied);
      retainedBytes += copied;
      if (complete && retainedBytes < prefix.length) prefix[retainedBytes++] = 10;
    }
    lineBytes = 0;
  };
  stream.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (lineBytes < lineBudget)
        chunk.copy(line, lineBytes, start, Math.min(end, start + lineBudget - lineBytes));
      lineBytes += end - start;
      if (newline === -1) break;
      consume();
      start = end + 1;
    }
  });
  const finish = () => {
    consume(false);
    const truncated = observedBytes > retainedBytes;
    let text = prefix.subarray(0, retainedBytes).toString('utf8');
    const startup = terminalEvidence(text);
    if (truncated && password) {
      for (let length = password.length; length > 0; length--) {
        if (text.endsWith(password.slice(0, length))) {
          text = text.slice(0, -length) + '[redacted-partial]';
          break;
        }
      }
    }
    prefix.fill(0);
    line.fill(0);
    return {
      report,
      health,
      startup:
        sawOversizeLine && !('reason' in startup) ? { report: 'over-budget' as const } : startup,
      stderr: {
        text: String(diagnosticValue(text, '', new Set(), [password])),
        observedBytes,
        retainedBytes,
        truncated,
      },
    };
  };
  return { finish, health: () => health };
}

async function persistedReport(directory: string, password: string) {
  try {
    const file = await open(await safePath(directory, 'report.json'), 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) return;
      const bytes = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead === bytes.length && (await file.stat()).size === stat.size)
        return v3Report(JSON.parse(bytes.toString('utf8')), password);
    } finally {
      await file.close();
    }
  } catch {
    // Bootstrap failures can occur before the output directory exists.
  }
}

/** Retain pre-report bootstrap reasons only; unrelated stderr stays private. */
function terminalEvidence(prefix: string) {
  const text = prefix.trim();
  if (!text) return { report: 'missing' as const };
  const preReport = ['output-directory-unavailable', 'configuration-boundary'];
  const token = text.split(/\r?\n/).find((line) => preReport.includes(line));
  return token ? { report: 'missing' as const, reason: token } : { report: 'invalid' as const };
}

/** Explicit composition only. The released supervisor owns connection retry. */
export function startObserverProcess<R extends GameEventSourceRole>(
  options: ObserverProcessOptions<R>,
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
    ![options.executable, options.native, options.steamApi, options.outputDirectory].every(
      isAbsolute,
    ) ||
    (process.env.SteamAppId !== undefined && process.env.SteamAppId !== '730')
  ) {
    throw new Error('Invalid observer launch configuration');
  }
  const manager = createObserverSourceManager({ role: options.role });
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
    '--managed',
    '--native',
    options.native,
    '--steam-api',
    options.steamApi,
    '--host-version',
    String(options.hostVersion),
    '--output',
    options.outputDirectory,
    ...(seconds === undefined ? [] : ['--seconds', String(seconds)]),
  ];
  const child = spawn(
    options.launcher ?? options.executable,
    options.launcher ? ['--observer-process', options.job!, options.executable, ...args] : args,
    {
      cwd: dirname(options.executable),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const attemptId = randomUUID();
  let spawnCode: string | undefined;
  let processError: unknown;
  let exitSignal: string | null = null;
  let ready = false;
  let startupTimedOut = false;
  let startedSupervisor = false;
  const startupTimer = setTimeout(() => {
    startupTimedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  const unsubscribe = manager.subscribe(() => {
    const health = manager.getHealth();
    if (health.generation > 0 && health.state === 'connecting') {
      startedSupervisor = true;
      clearTimeout(startupTimer);
    }
    if (health.state === 'live') ready = true;
  });
  manager.start();
  let exited = false;
  let inputFailed = false;
  let stoppingRequested = false;
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      processError = error;
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
  const diagnostics = captureDiagnostics(child.stderr, options.password);
  const configuration = Buffer.from(
    JSON.stringify({ endpoint: options.endpoint, password: options.password }) + '\n',
  );
  child.stdin.on('error', (error) => {
    processError = error;
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
  const closed = Promise.all([exit, reading]).then(async ([code, output]) => {
    unsubscribe();
    clearTimeout(startupTimer);
    const received = diagnostics.finish();
    const report =
      received.report ??
      (await persistedReport(options.outputDirectory, options.password)) ??
      received.startup;
    const reason = 'reason' in report ? report.reason : undefined;
    const stage = spawnCode
      ? 'spawn'
      : reason === 'output-directory-unavailable'
        ? 'output-directory'
        : reason === 'configuration-boundary'
          ? 'configuration'
          : reason === 'native-start-failed'
            ? 'native-boot'
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
      hostVersion: options.hostVersion,
      reportDirectory: basename(options.outputDirectory),
      stage,
      code,
      signal: exitSignal,
      ...(spawnCode ? { spawnCode } : {}),
      ...(processError === undefined
        ? {}
        : { error: diagnosticValue(processError, '', new Set(), [options.password]) }),
      ready,
      startupTimedOut,
      cancelled: stoppingRequested,
      stdout: diagnosticValue(output, '', new Set(), [options.password]) as typeof output,
      stderr: received.stderr,
      ...(received.health ? { supervisor: received.health } : {}),
      ...('supervisor' in report && report.supervisor ? { supervisor: report.supervisor } : {}),
    };
    try {
      options.onAttempt?.(terminal);
    } catch {
      console.error('observer_attempt_diagnostic_failed');
    }
    const failed = output.status === 'failed' || inputFailed || startupTimedOut || code !== 0;
    const sourceHealth = manager.getHealth();
    if (failed && sourceHealth.state === 'ended' && sourceHealth.mapName !== undefined) {
      manager.disconnectObserver('failed');
    }
    return {
      terminal,
      failed,
      crashed:
        startedSupervisor &&
        !stoppingRequested &&
        !inputFailed &&
        !startupTimedOut &&
        output.status !== 'failed' &&
        report.report !== 'received' &&
        (exitSignal !== null || (code !== null && (code < 0 || code >= 0x80000000))),
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
        await manager.stop();
        if (!exited) child.stdin.end();
        // Allow the component's bounded finalizers to finish first.
        await waitForExit(15_000);
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
      await owner.closed;
    },
    getHealth: () => manager.getHealth(),
    getRecentGameEvents: () => manager.getRecentGameEvents(),
    getRecentDiagnostics: () => manager.getRecentDiagnostics(),
    getSnapshot: () => manager.getSnapshot(),
    subscribe: (listener) => manager.subscribe(listener),
    subscribeLiveGameEvents: (listener) => manager.subscribeLiveGameEvents(listener),
    ...(manager.subscribeTimelineReset
      ? { subscribeTimelineReset: (listener) => manager.subscribeTimelineReset!(listener) }
      : {}),
  };
  return { ...owner, source, health: diagnostics.health };
}
