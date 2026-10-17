/** Synthetic capacity probe through production journal/outbox; never uploads externally.
 * Run: pnpm --filter @mizar/companion exec tsx test/support/measure-diagnostic-delivery.ts
 * Accelerated model time is explicit; this is not a Windows/CS2 field recording.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { DiagnosticDelivery, decodeDiagnosticBatch } from '../../src/support/delivery.js';
import { SessionJournal } from '../../src/support/session-journal.js';

async function measure(profile: 'normal' | 'fault', minutes: number) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-diagnostic-capacity-'));
  const received = new Map<string, Buffer>();
  const options = {
    endpoint: 'https://synthetic.invalid',
    fetch: (async (input, init) => {
      await Promise.resolve();
      const path = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      ).pathname;
      if (path.endsWith('/enroll')) {
        assert.equal(typeof init?.body, 'string');
        const value = JSON.parse(init!.body as string) as { enrollmentId: string };
        return Response.json({
          installationId: value.enrollmentId,
          token: 'synthetic-only',
          expiresAt: Date.now() + 86400_000,
        });
      }
      assert.equal(init?.method, 'PUT');
      const body = Buffer.from(init.body as Uint8Array);
      const id = createHash('sha256').update(body).digest('hex');
      assert.equal(path.split('/').at(-1), id);
      received.set(id, body);
      return Response.json({ accepted: true, batchId: id, sha256: id });
    }) satisfies typeof fetch,
  };
  let journal = new SessionJournal(root);
  // First persist offline; restore and drain through production send/ACK afterwards.
  let delivery = await new DiagnosticDelivery(root, journal).initialize(false);
  await delivery.consent(true);
  const taskId = randomUUID();
  const stages: Record<string, number> = {};
  const expectedFailures = profile === 'normal' ? Math.ceil(minutes / 10) : 6000 * minutes;
  const start = performance.now();
  let emitted = 0;
  const emit = async (stage: string, evidence: unknown) => {
    journal.record(stage, evidence);
    stages[stage] = (stages[stage] ?? 0) + 1;
    if (++emitted % 64 === 0) await journal.flush();
  };
  for (let minute = 0; minute < minutes; minute++) {
    if (profile === 'normal') {
      // Explicit load assumption: 4 own control reads / 2s, each incoming+response.
      for (let request = 0; request < 120; request++) {
        const requestId = randomUUID();
        const route = [
          '/local/v1/production',
          '/local/v1/obs',
          '/local/v1/obs/confidence',
          '/local/v1/diagnostics/delivery',
        ][request % 4]!;
        await emit('service_log', {
          level: 30,
          requestId,
          msg: 'incoming request',
          req: { method: 'GET', url: route, remoteAddress: '127.0.0.1' },
          simulatedMinute: minute,
        });
        await emit('service_log', {
          level: 30,
          requestId,
          msg: 'request completed',
          res: { statusCode: 200 },
          responseTime: 2 + (request % 13),
          simulatedMinute: minute,
        });
      }
      for (let window = 0; window < 4; window++) {
        const sequence = minute * 600 + window * 150;
        await emit('runtime_performance_window', {
          reason: 'interval',
          windowMs: 15000,
          schedulerDelayMs: 1,
          input: {
            raw: { sequence, receivedMonotonicMs: minute * 60000 + window * 15000 },
            normalized: { sequence },
            ageMs: 40,
          },
          processing: { count: 150, meanMs: 2.5, maxMs: 12, totalMs: 375 },
          slowProcessing: { count: 0, omittedSamples: 0, samples: [] },
          channels: ['program', 'radar', 'operator', 'assist'].map((channel) => ({
            channel,
            channelSeq: sequence,
            cursor: { programReceiveSequence: sequence },
            subscribers: { connected: 2, sent: sequence, dropped: 0 },
          })),
          runtime: { mode: 'live', map: 'de_ancient', source: 'gsi', taskId },
          recorder: { accepted: sequence, dropped: 0 },
          delivery: [],
          cstv: { connected: false },
        });
        for (const page of ['/hud', '/production'])
          await emit('browser_control', {
            action: 'browser_performance',
            phase: 'window',
            evidence: {
              page,
              reason: 'interval',
              windowMs: 15000,
              visibility: 'visible',
              frames: { callbacks: 900, maxGapMs: 18, over50ms: 0 },
              longTasks: { supported: true, count: 0, maxDurationMs: 0 },
              channels: ['program', 'radar'].map((channel) => ({
                channel,
                messages: 150,
                accepted: 150,
                unchanged: 0,
                maxHandleMs: 2,
                maxReceiveGapMs: 100,
                channelSeq: sequence,
                cursor: { programReceiveSequence: sequence },
              })),
              anomalyCount: 0,
              omittedAnomalySamples: 0,
              anomalies: [],
            },
          });
      }
      // A root operation with state transitions every minute, including 12 failed attempts.
      for (const phase of ['received', 'begin', 'result'])
        await emit(`operation_${phase}`, {
          taskId,
          operationId: randomUUID(),
          trigger: 'user',
          route: '/operator/production/config',
          method: 'POST',
          simulatedMinute: minute,
          before: { mode: 'live', revision: minute },
          after: { mode: 'live', revision: minute + 1 },
          result: phase === 'result' ? 'confirmed' : 'started',
        });
    }
    const errors = profile === 'normal' ? (minute % 10 === 0 ? 1 : 0) : 6000;
    for (let errorIndex = 0; errorIndex < errors; errorIndex++)
      await emit('request_error', {
        taskId,
        operationId: randomUUID(),
        trigger: 'user',
        retry: errorIndex,
        route: '/operator/music/config',
        method: 'PUT',
        before: { enabled: false },
        after: { enabled: false },
        simulatedMinute: minute,
        simulatedMs: errorIndex * 10,
        result: 'failed',
        reason: 'music_file_write_failed',
        error: new Error('Cannot save music configuration', {
          cause: Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
            syscall: 'write',
          }),
        }),
      });
    await journal.flush();
    await delivery.tick();
  }
  const before = delivery.status();
  const manifest = await readFile(join(root, 'diagnostic-outbox/state.json'));
  const disk = JSON.parse(manifest.toString()) as { queue: { index: unknown }[] };
  const indexBytes = disk.queue.reduce(
    (n, batch) => n + Buffer.byteLength(JSON.stringify(batch.index)),
    0,
  );
  const files = (await readdir(join(root, 'diagnostic-outbox'))).filter((name) =>
    name.endsWith('.gz'),
  );
  const bodies = await Promise.all(
    files.map((name) => readFile(join(root, 'diagnostic-outbox', name))),
  );
  let expanded = 0;
  let events = 0;
  let failures = 0;
  for (const body of bodies) {
    const decoded = await decodeDiagnosticBatch(body);
    expanded += Buffer.byteLength(JSON.stringify(decoded));
    events += decoded.events!.length;
    for (const item of decoded.events!) {
      const event = item as { stage: string; evidence: { error?: { cause?: { code?: string } } } };
      if (event.stage === 'request_error') {
        assert.equal(event.evidence.error?.cause?.code, 'ENOSPC');
        failures++;
      }
    }
  }
  assert.equal(failures, expectedFailures);
  assert.equal(journal.health().dropped, 0);
  assert(
    Object.keys(before.omissionReasons).every(
      (reason) => reason === 'memory_budget_recoverable_from_local_journal',
    ),
  );
  await delivery.close();
  await journal.close();
  journal = new SessionJournal(root);
  delivery = await new DiagnosticDelivery(root, journal, options).initialize(false);
  let ticks = 0;
  while (delivery.status().queuedBatches && ticks < 260) {
    await delivery.tick();
    ticks++;
  }
  assert.equal(delivery.status().queuedBatches, 0);
  assert(received.size >= files.length);
  const total = bodies.reduce((n, body) => n + body.length, 0);
  const result = {
    profile,
    modelMinutes: minutes,
    wallMs: performance.now() - start,
    emittedEvents: emitted,
    queuedEvents: events,
    stages,
    expandedBatchBytes: expanded,
    batchIndexJsonBytes: indexBytes,
    localManifestBytes: manifest.length,
    gzipBytes: total,
    batches: files.length,
    failureChainsVerified: failures,
    omissions: before.omissionReasons,
    restartDrainTicks: ticks,
    actualNetwork: 'in-memory service, no external upload',
    limitations:
      'Synthetic rate and payload model, accelerated time. Uses production journal/outbox. No Windows/CS2/OBS session or new task/anomaly/console integration represented.',
  };
  await delivery.close();
  await journal.close();
  await rm(root, { recursive: true, force: true });
  return result;
}
const results = [await measure('normal', 120), await measure('fault', 1)];
const concurrent = [];
for (const installations of [10, 30, 100]) {
  const start = performance.now();
  const rows = await Promise.all(Array.from({ length: installations }, () => measure('normal', 1)));
  concurrent.push({
    installations,
    modelMinutesEach: 1,
    wallMs: performance.now() - start,
    emittedEvents: rows.reduce((n, row) => n + row.emittedEvents, 0),
    gzipBytes: rows.reduce((n, row) => n + row.gzipBytes, 0),
    expandedBytes: rows.reduce((n, row) => n + row.expandedBatchBytes, 0),
    failureChainsVerified: rows.reduce((n, row) => n + row.failureChainsVerified, 0),
    productionLocalPipelines: installations,
    remote: 'in-memory ACK; not Worker request/CPU/CF quota benchmark',
  });
}
const normal = results[0]!;
const forecast = [10, 30, 100].map((installations) => ({
  installations,
  twoHourSessionsPerInstallationPerDay: 3,
  gzipBytesPerHour: normal.gzipBytes / 2,
  gzipBytesPerInstallationPerDay: normal.gzipBytes * 3,
  gzipBytesSevenDaysAll: normal.gzipBytes * 3 * 7 * installations,
  uploadPutsPerDayAll: normal.batches * 3 * installations,
  measuredIndexJsonBytes90DaysAll: normal.batchIndexJsonBytes * 3 * installations * 90,
  indexEnvelopeBytesAt1KiB90DaysAll: normal.batches * 3 * installations * 90 * 1024,
}));
console.log(
  JSON.stringify(
    {
      schema: 'mizar-diagnostic-capacity/1',
      normalPollingAssumption: '4 GET per 2s, incoming+response journal event each',
      uploadCadenceModel: 'one batch per minute; overload drain ticks are NOT elapsed real minutes',
      results,
      concurrent,
      forecast,
    },
    null,
    2,
  ),
);
