/** Local file experiment, NOT a network spectator client. Never feeds production projections. */
import { randomUUID } from 'node:crypto';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { viewerDecoder } from '@mizar/telemetry-cstv/viewer-research';
import { growingDemo } from './follow.js';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    follow: { type: 'boolean' },
    seconds: { type: 'string', default: '300' },
    offset: { type: 'string', default: '120' },
  },
});
const seconds = Number(values.seconds);
const offset = Number(values.offset);
if (
  !values.input ||
  !values.output ||
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  seconds > 14400 ||
  !Number.isFinite(offset) ||
  offset < 0 ||
  offset > 3600
) {
  throw new Error(
    'usage: --input FILE --output NEW_DIRECTORY [--follow --seconds 300 --offset 120]',
  );
}
await mkdir(values.output); // Never overwrite a prior evidence run.
const streamInstance = randomUUID();
const output = await open(join(values.output, 'events.jsonl'), 'wx', 0o600);
const abort = new AbortController();
const began = performance.now();
const cpu = process.cpuUsage();
const counts: Record<string, number> = {};
let sequence = 0;
let bytes = 0;
let initialBytes = 0;
let initialTick: number | null = null;
let appendedEvents = 0;
let stopped = false;
let writeQueue = '';
let failure = false;
let outcome: string = 'not-started';
let magicChecked = 0;
const magic = Buffer.from('PBDEMS2\0');
const decoder = viewerDecoder((event) => {
  counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  // Read-ahead means byte position alone cannot establish fresh event provenance.
  // This is only an offline append observation, never a live-match success flag.
  if (bytes <= initialBytes || initialTick === null) initialTick = event.tick;
  const afterInitialBytes = bytes > initialBytes && event.tick > initialTick;
  if (afterInitialBytes && event.kind !== 'cursor') appendedEvents++;
  const record = {
    schema: 'mizar.viewer.event.v1',
    streamInstance,
    sequence: ++sequence,
    observedAt: new Date().toISOString(),
    observedMonotonicMs: performance.now() - began,
    inputBytesRead: bytes,
    afterInitialBytes,
    source: 'demo-file',
    ...event,
    configuredOffsetSeconds: offset,
    displayTime: null,
    displayBinding: 'unverified',
  };
  writeQueue += JSON.stringify(record) + '\n';
  if (writeQueue.length > 8 * 1024 ** 2) throw new Error('event-output-budget');
});
const stop = () => {
  stopped = true;
  abort.abort();
  decoder.cancel();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const timeout = setTimeout(stop, seconds * 1000);
let input: ReadableStream<Uint8Array> | undefined;
let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let failureStage = 'open-source';
try {
  input = await growingDemo(values.input, {
    follow: values.follow ?? false,
    signal: abort.signal,
    onRead: (n, initial) => {
      bytes = n;
      initialBytes = initial;
    },
  });
  const reader = input.getReader();
  sourceReader = reader;
  failureStage = 'decode-or-read-source';
  const validated = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (writeQueue) {
          await output.writeFile(writeQueue);
          writeQueue = '';
        }
        const next = await reader.read();
        if (next.done) {
          if (magicChecked < magic.length) throw new Error('incomplete-demo-header');
          controller.close();
          return;
        }
        for (let i = 0; i < next.value.length && magicChecked < magic.length; i++, magicChecked++) {
          if (next.value[i] !== magic[magicChecked]) throw new Error('invalid-cs2-demo-magic');
        }
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  outcome = (await decoder.parse(validated)).status;
  if (outcome !== 'complete' && !stopped) failure = true;
  if (!failure) failureStage = 'none';
} catch {
  outcome = stopped ? 'stopped-incomplete' : 'failed';
  failure = !stopped;
} finally {
  clearTimeout(timeout);
  abort.abort();
  if (sourceReader) {
    await sourceReader.cancel().catch(() => {});
    sourceReader.releaseLock();
  } else if (input) {
    await input.cancel().catch(() => {});
  }
  if (writeQueue) await output.writeFile(writeQueue);
  await output.close();
  const usage = process.cpuUsage(cpu);
  const report = {
    schema: 'mizar.viewer.decode-report.v1',
    streamInstance,
    outcome,
    failureStage: failure ? failureStage : null,
    counts,
    initialBytes,
    bytesRead: bytes,
    appendedEvents,
    elapsedMs: performance.now() - began,
    cpuMs: (usage.user + usage.system) / 1000,
    peakRssKiB: process.resourceUsage().maxRSS,
    configuredOffsetSeconds: offset,
    ordinaryViewerHandshake: 'INCONCLUSIVE',
    liveContinuousReceipt: 'INCONCLUSIVE',
    displayBinding: 'unverified',
    windows: 'NOT_RUN',
  };
  await writeFile(join(values.output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
  if (failure) process.exitCode = 1;
}
