import {
  createCstvLiveSession,
  type CstvLiveSession,
  type CstvSessionTerminalStatus,
} from '@mizar/telemetry-cstv';

interface ProbeOptions {
  readonly url: string;
  readonly role: 'program' | 'lookahead';
  readonly maxEvents?: number;
  readonly durationMs?: number;
}

function usage(): void {
  console.error(
    'Usage: pnpm cstv:probe -- --url <http(s)://...> --role <program|lookahead> [--max-events N] [--duration-ms N]',
  );
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptions(argv: readonly string[]): ProbeOptions | undefined {
  let url: string | undefined;
  let role: ProbeOptions['role'] | undefined;
  let maxEvents: number | undefined;
  let durationMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--url' && value !== undefined) {
      url = value;
      index += 1;
    } else if (flag === '--role' && (value === 'program' || value === 'lookahead')) {
      role = value;
      index += 1;
    } else if (flag === '--max-events' && value !== undefined) {
      const parsed = parsePositiveInteger(value);
      if (parsed === undefined) return undefined;
      maxEvents = parsed;
      index += 1;
    } else if (flag === '--duration-ms' && value !== undefined) {
      const parsed = parsePositiveInteger(value);
      if (parsed === undefined) return undefined;
      durationMs = parsed;
      index += 1;
    } else {
      return undefined;
    }
  }

  if (url === undefined || role === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return {
    url,
    role,
    ...(maxEvents === undefined ? {} : { maxEvents }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function printTerminal(status: CstvSessionTerminalStatus, eventCount: number): void {
  console.log(`FINAL status=${status} events=${eventCount}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options === undefined) {
    usage();
    process.exitCode = 2;
    return;
  }

  const stopController: { stop: () => void } = { stop: () => undefined };
  let eventCount = 0;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  const session: CstvLiveSession = createCstvLiveSession({
    role: options.role,
    generation: 0,
    url: options.url,
    onSync: (sync) =>
      console.log(
        `CONNECTED role=${options.role} protocol=${sync.protocol} map=${sync.mapName ?? 'unknown'} tps=${sync.ticksPerSecond} tick=${sync.tick}`,
      ),
    onObservation: (observation) => {
      eventCount += 1;
      console.log(
        `EVENT tick=${observation.cursor.tick} seq=${observation.cursor.sequence} kind=${observation.kind}`,
      );
      if (options.maxEvents !== undefined && eventCount >= options.maxEvents) stopController.stop();
    },
    onDiagnostic: (diagnostic) =>
      console.error(
        `DIAGNOSTIC role=${options.role} code=${diagnostic.code}${diagnostic.eventName === undefined ? '' : ` event=${diagnostic.eventName}`}`,
      ),
  });

  stopController.stop = () => session.stop();
  const stop = (): void => stopController.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (options.durationMs !== undefined) durationTimer = setTimeout(stop, options.durationMs);

  try {
    const started = await session.start();
    if (started.status !== 'ready') {
      printTerminal(started.status, eventCount);
      return;
    }
    const result = await session.run();
    printTerminal(result.status, eventCount);
  } catch {
    console.error('CSTV PROBE failed code=session-failed');
    process.exitCode = 1;
  } finally {
    if (durationTimer !== undefined) clearTimeout(durationTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    session.stop();
  }
}

void main();
