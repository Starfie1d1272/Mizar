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
  readonly outcome?: 'failed' | 'incomplete' | 'closed' | undefined;
  readonly phase?: string | undefined;
  readonly nativeBootCode?: number | undefined;
  readonly steamInitResult?: number | undefined;
  readonly remoteEndReason?: number | undefined;
  readonly drainCompleted?: boolean | undefined;
  readonly cleanupCompleted?: boolean | undefined;
  readonly reportWritten?: boolean;
  readonly lastOutputSequence?: number;
  readonly supervisor?: ReturnType<typeof supervisorHealth>;
  readonly finalizationFailures: readonly string[];
}

const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function supervisorHealth(input: unknown, source: string, password: string) {
  const value = object(input);
  const channel = integer(value.channel);
  const world = integer(value.world);
  if (
    value.type !== 'cs2-observer-health/2' ||
    value.source !== source ||
    channel === undefined ||
    world === undefined ||
    typeof value.ready !== 'boolean'
  )
    return;
  const state = String(value.state);
  if (
    !['initializing', 'connected', 'catching-up', 'retiring', 'backoff', 'stopped'].includes(state)
  )
    return;
  const fault = object(value.lastFault);
  const reason =
    typeof fault.reason === 'string' &&
    /^[a-z0-9-]{1,80}$/.test(fault.reason) &&
    (!password || !fault.reason.includes(password))
      ? fault.reason
      : undefined;
  return {
    channel,
    world,
    state,
    ready: value.ready,
    reconnects: integer(value.reconnects),
    retryInMs: integer(value.retryInMs),
    forwardMaxUs: integer(value.forwardMaxUs),
    stdoutOldestAgeUs: integer(object(value.output).oldestAgeUs),
    deliveredSequence: integer(object(value.output).lastDeliveredSequence),
    sdkQueueAgeUs: integer(object(value.attempt).sdkQueueAgeUs),
    ...(reason
      ? {
          lastFault: {
            reason,
            channel: integer(fault.channel),
            nativeFailure: integer(fault.nativeFailure),
            remoteEndReason: integer(fault.remoteEndReason),
          },
        }
      : {}),
  };
}

function v2Report(input: unknown, source: string, password: string) {
  const row = object(input);
  const supervisor = supervisorHealth(row.health, source, password);
  if (
    row.schema !== 'cs2-observer-report/2' ||
    !['failed', 'closed', 'incomplete'].includes(String(row.outcome)) ||
    typeof row.cleanupCompleted !== 'boolean' ||
    typeof row.reportWritten !== 'boolean' ||
    integer(row.lastOutputSequence) === undefined ||
    typeof row.reason !== 'string' ||
    !supervisor
  )
    return;
  const detail = String(diagnosticValue(row.reason, '', new Set(), [password]));
  return {
    report: 'received' as const,
    outcome: row.outcome as 'failed' | 'closed' | 'incomplete',
    reason: /^[a-z0-9-]{1,80}$/.test(detail) ? detail : 'unclassified',
    detail,
    cleanupCompleted: row.cleanupCompleted,
    reportWritten: row.reportWritten,
    lastOutputSequence: integer(row.lastOutputSequence)!,
    phase: undefined,
    finalizationFailures: row.reportWritten ? [] : ['write-report'],
    supervisor,
  };
}

/** Stderr is continuously drained. Keep a small startup excerpt and one typed report. */
function captureDiagnostics(stream: NodeJS.ReadableStream, source: string, password: string) {
  const lineBudget = 64 * 1024;
  const prefix = Buffer.alloc(4096);
  const line = Buffer.alloc(lineBudget);
  let lineBytes = 0;
  let retainedBytes = 0;
  let sawOversizeLine = false;
  let observedBytes = 0;
  let report:
    | ReturnType<typeof v2Report>
    | Extract<ReturnType<typeof terminalEvidence>, { report: 'received' }>;
  let health: ReturnType<typeof supervisorHealth>;
  const consume = (complete = true) => {
    const oversized = lineBytes >= lineBudget;
    let structured = false;
    if (!oversized && lineBytes && line[0] === 123) {
      try {
        const text = line.subarray(0, lineBytes).toString('utf8');
        const row: unknown = JSON.parse(text);
        const sample = supervisorHealth(row, source, password);
        if (
          sample &&
          (!health ||
            sample.channel > health.channel ||
            (sample.channel === health.channel && sample.world >= health.world))
        )
          health = sample;
        const terminal = complete ? v2Report(row, source, password) : undefined;
        const legacy =
          object(row).schema === 'cs2-observer-report/1'
            ? terminalEvidence(text, password)
            : undefined;
        if (terminal) report = terminal;
        else if (!report && legacy?.report === 'received') report = legacy;
        structured = Boolean(sample || terminal || legacy?.report === 'received');
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
    const startup = terminalEvidence(text, password);
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
        sawOversizeLine && startup.report !== 'received' && !('reason' in startup)
          ? { report: 'over-budget' as const }
          : startup,
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

async function persistedReport(directory: string, source: string, password: string) {
  try {
    const file = await open(await safePath(directory, 'report.json'), 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) return;
      const bytes = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead === bytes.length && (await file.stat()).size === stat.size)
        return v2Report(JSON.parse(bytes.toString('utf8')), source, password);
    } finally {
      await file.close();
    }
  } catch {
    // Bootstrap failures can occur before the output directory exists.
  }
}

/** Retain the structured report's cause; unrelated stderr and configuration stay private. */
function terminalEvidence(prefix: string, password = '') {
  const text = prefix.trim();
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
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (
        !(
          row.schema === 'cs2-observer-report/1' &&
          typeof row.reachedFull === 'boolean' &&
          typeof row.drainCompleted === 'boolean' &&
          typeof row.cleanupCompleted === 'boolean'
        ) ||
        !['failed', 'incomplete', 'closed'].includes(String(row.outcome))
      )
        continue;
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
        detail:
          typeof row.reason === 'string'
            ? String(diagnosticValue(row.reason, '', new Set(), [password]))
            : undefined,
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
      continue;
    }
  }
  return absentReport();
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
  const identity = { source: `${role}:${sourceId}`, role, channel: 0, world: 1 } as const;
  const manager = createObserverSourceManager({ role: options.role, identity });
  const env: NodeJS.ProcessEnv = { SteamAppId: '730', PYTHONDONTWRITEBYTECODE: '1' };
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
    '--managed-protocol',
    '2',
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
  const diagnostics = captureDiagnostics(child.stderr, identity.source, options.password);
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
      (await persistedReport(options.outputDirectory, identity.source, options.password)) ??
      received.startup;
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
      finalizationFailures:
        report.report === 'received' && 'finalizationFailures' in report
          ? (report.finalizationFailures ?? [])
          : [],
    };
    try {
      options.onAttempt?.(terminal);
    } catch {
      console.error('observer_attempt_diagnostic_failed');
    }
    const failed =
      report.report !== 'received' ||
      terminal.outcome === 'failed' ||
      terminal.cleanupCompleted !== true ||
      terminal.reportWritten === false ||
      terminal.finalizationFailures.length > 0 ||
      output.status === 'failed' ||
      inputFailed ||
      startupTimedOut ||
      (code !== 0 && code !== 2);
    const sourceHealth = manager.getHealth();
    if (
      !failed &&
      code === 0 &&
      terminal.outcome === 'closed' &&
      terminal.reason === 'source-hltv-stop'
    ) {
      manager.confirmObserverDrain();
    } else if (sourceHealth.state === 'ended' && sourceHealth.mapName !== undefined) {
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
        // Allow the component's bounded parser/output finalizers to finish first.
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
  return { ...owner, source, health: diagnostics.health };
}
