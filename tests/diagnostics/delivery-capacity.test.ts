import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import {
  DiagnosticDelivery,
  DELIVERY_LIMITS,
  decodeDiagnosticBatch,
} from '../../apps/companion/src/support/delivery.js';
import { meteredRuntime } from '../../scripts/diagnostics/capacity-runtime.mjs';
import { migrate } from './fixture.js';

test('large retained history survives rotation, preserves operations, and closes across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-retention-index-'));
  const timestamp = '2026-11-13T11:36:47.211Z';
  const removedSegments = Array.from({ length: 4096 }, () => ({
    name: `session-${randomUUID()}.ndjson`,
    producerRunId: randomUUID(),
    firstSequence: 1,
    lastSequence: 100,
    firstObservedAt: timestamp,
    lastObservedAt: timestamp,
    records: 100,
    physicalId: `2023638739:15762598695999558:${'a'.repeat(64)}`,
    bytes: 1024,
    sha256: 'a'.repeat(64),
    sealedAt: timestamp,
    removedAt: timestamp,
    reason: 'retention',
  }));
  const inventory = {
    schema: 'mizar-retention/2',
    producerId: 'companion',
    segments: [],
    pins: [],
    deleting: [],
    removedSegments,
    removed: { files: 4096, bytes: 4096 * 1024, lastAt: timestamp },
  };
  const body = JSON.stringify(inventory);
  assert(Buffer.byteLength(body) > 2 * 1024 * 1024);
  assert(Buffer.byteLength(body) < 4 * 1024 * 1024);
  const inventoryPath = join(root, 'retention-companion.json');
  await writeFile(inventoryPath, body);
  const journal = new SessionJournal(root);
  try {
    await journal.recordCommitted('business_capacity_probe', { marker: 'retained-business' });
    await journal.withRequest(
      { requestId: 'capacity', browserOperationId: null, taskId: randomUUID(), trigger: 'user' },
      () => journal.recordCommitted('operation_result', { marker: 'retained-operation' }),
    );
    const error = { message: 'OBS unavailable', stack: 'x'.repeat(1024 * 1024 - 4096) };
    for (let sequence = 0; sequence < 72; sequence++)
      await journal.recordCommitted('obs_connect', { result: 'failure', sequence, error });
    await journal.recordCommitted('after_capacity', {});
    await journal.close();
    const health = journal.health();
    assert.equal(health.pendingRecords, 0);
    assert.equal(health.writeError, null);
    assert.equal(health.dropped, 0);
    const names = (await readdir(root)).filter((name) => /^session-.*\.ndjson$/.test(name));
    const text = (await Promise.all(names.map((name) => readFile(join(root, name), 'utf8')))).join(
      '',
    );
    assert(Buffer.byteLength(text) <= 64 * 1024 * 1024);
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert(events.some((event) => event.evidence.marker === 'retained-business'));
    assert(events.some((event) => event.evidence.marker === 'retained-operation'));
    assert(events.some((event) => event.stage === 'after_capacity'));
    assert(events.some((event) => event.stage === 'session_end'));
    const saved = JSON.parse(await readFile(inventoryPath, 'utf8'));
    assert(saved.removed.files > inventory.removed.files);
    const collected = saved.removed.files - inventory.removed.files;
    assert.deepEqual(saved.removedSegments.slice(0, -collected), removedSegments.slice(collected));
    const restarted = new SessionJournal(root);
    try {
      await restarted.recordCommitted('after_restart', {});
      await restarted.close();
      assert.equal(restarted.health().writeError, null);
      assert.equal(restarted.health().pendingRecords, 0);
      assert.equal(restarted.health().dropped, 0);
    } finally {
      await restarted.close();
    }
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('interleaved producers share collection; failed manifest advances no source before restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-batching-'));
  let journal = new SessionJournal(root);
  const options = {
    endpoint: 'https://diagnostics.invalid',
    fetch: async () => {
      throw new Error('network must remain paused');
    },
  };
  let delivery = await new DiagnosticDelivery(root, journal, options).initialize(false);
  const outbox = join(root, 'diagnostic-outbox');
  const manifest = () => readFile(join(outbox, 'state.json'), 'utf8');
  const producer = randomUUID();
  try {
    await delivery.consent(true);
    await delivery.pause(true);
    await journal.flush();
    await Promise.all([delivery.tick(), delivery.tick()]);
    const before = await manifest();
    const oldIds = new Set(JSON.parse(before).queue.map((batch: { id: string }) => batch.id));
    for (let sequence = 1; sequence <= 160; sequence++) {
      await journal.recordDocumentCommitted({
        schema: 'mizar-diagnostic-event/2',
        eventId: `${producer}:${sequence}`,
        producerKind: 'document',
        producerRunId: producer,
        sequence,
        kind: 'batching_probe',
        observedAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        phase: null,
        outcome: null,
        monotonicMs: null,
        sourceInterval: null,
        taskId: null,
        operationId: null,
        parentOperationId: null,
        attemptId: null,
        scope: null,
        evidence: { count: sequence },
        coverage: {
          durability: 'committed',
          unknown: [],
          excluded: [],
          replayCount: 0,
          occurrences: 1,
        },
      });
      await journal.recordCommitted('batching_probe', { count: sequence });
    }
    await delivery.tick(false);
    assert.equal(
      delivery.status().queuedBatches,
      oldIds.size,
      'polling must not seal tiny batches',
    );
    const batchLimit = DELIVERY_LIMITS.batches;
    try {
      DELIVERY_LIMITS.batches = oldIds.size + 1;
      await delivery.tick();
      assert(
        (await manifest()) === before,
        'one free slot must not fragment a two-producer prefix',
      );
    } finally {
      DELIVERY_LIMITS.batches = batchLimit;
    }
    const files = (await readdir(outbox)).sort();
    // A real filesystem failure after packet fsync, before manifest replacement.
    await mkdir(join(outbox, 'state.json.tmp'));
    await assert.rejects(delivery.tick());
    assert.equal(await manifest(), before, 'all producer cursors remain at the durable prefix');
    await assert.rejects(delivery.close());
    await rm(join(outbox, 'state.json.tmp'), { recursive: true });
    assert.deepEqual(
      (await readdir(outbox)).sort(),
      files,
      'failed transaction leaves no new packets',
    );
    await journal.close();
    journal = new SessionJournal(root);
    await journal.flush();
    delivery = await new DiagnosticDelivery(root, journal, options).initialize(false);
    const saved = JSON.parse(await manifest());
    const added = saved.queue.filter((batch: { id: string }) => !oldIds.has(batch.id));
    const found = new Map<string, number[]>();
    const ids = new Set<string>();
    let probeBatches = 0;
    for (const batch of added) {
      const decoded = await decodeDiagnosticBatch(await readFile(join(outbox, batch.id + '.gz')));
      const events = decoded.events.filter((event) => event.stage === 'batching_probe');
      if (!events.length) continue;
      probeBatches++;
      for (const event of events) {
        assert(!ids.has(String(event.eventId)), 'no duplicated source event');
        ids.add(String(event.eventId));
        const values = found.get(String(event.producerKind)) ?? [];
        values.push(Number((event.evidence as { count: number }).count));
        found.set(String(event.producerKind), values);
      }
    }
    assert.equal(probeBatches, 2, '320 alternating records fit two producer batches');
    for (const kind of ['document', 'companion'])
      assert.deepEqual(
        found.get(kind),
        Array.from({ length: 160 }, (_, n) => n + 1),
      );
    const committedIds = saved.queue.map((batch: { id: string }) => batch.id);
    await delivery.close();
    delivery = await new DiagnosticDelivery(root, journal, options).initialize(false);
    assert.deepEqual(
      JSON.parse(await manifest()).queue.map((batch: { id: string }) => batch.id),
      committedIds,
    );
    await delivery.close();
    await journal.close();
    // Retained cursors from earlier runs must not impose a lifetime start limit.
    const history = JSON.parse(await manifest());
    while (Object.keys(history.sessions).length < 128)
      history.sessions[randomUUID()] = { from: 0, queued: 1 };
    await writeFile(join(outbox, 'state.json'), JSON.stringify(history));
    journal = new SessionJournal(root);
    delivery = await new DiagnosticDelivery(root, journal, options).initialize(false);
    assert.equal(delivery.status().error, null, 'old cursors must not block a new producer');
    await journal.recordCommitted('cursor_capacity_probe', {});
    await delivery.tick();
    const latest = JSON.parse(await manifest()).queue.at(-1);
    const decoded = await decodeDiagnosticBatch(await readFile(join(outbox, latest.id + '.gz')));
    assert(decoded.events.some((event) => event.stage === 'cursor_capacity_probe'));
    await delivery.close();
    delivery = await new DiagnosticDelivery(root, journal, options).initialize(false);
    assert.equal(delivery.status().error, null, 'cursor history survives restart past 128 runs');
  } finally {
    await delivery.close();
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retained ACK history frees sending capacity; quota retry survives restart and UTC reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-budget-'));
  const receiver = meteredRuntime(root, 160);
  const db = await receiver.getD1Database('DIAGNOSTICS_DB');
  await migrate(db);
  let now = Date.now();
  const day = Math.floor(now / 86400_000);
  const control = (accepting = true) =>
    receiver.dispatchFetch('https://diagnostics.invalid/__test/control', {
      method: 'POST',
      body: JSON.stringify({ now, accepting }),
    });
  await control();
  const journal = new SessionJournal(join(root, 'client'));
  const requests: { url: string; init: RequestInit; status?: number }[] = [];
  const options = {
    endpoint: 'https://diagnostics.invalid',
    now: () => now,
    // An unavailable source owner cannot authorize removing acknowledged wire.
    participants: () => [],
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('cf-connecting-ip', '192.0.2.10');
      const request: (typeof requests)[number] = { url: String(input), init: { ...init, headers } };
      requests.push(request);
      const response = await receiver.dispatchFetch(request.url, request.init);
      request.status = response.status;
      return response;
    },
  };
  let delivery = await new DiagnosticDelivery(join(root, 'client'), journal, options).initialize(
    false,
  );
  const batchLimit = DELIVERY_LIMITS.batches;
  try {
    DELIVERY_LIMITS.batches = 161;
    await delivery.consent(true);
    await delivery.pause(true);
    for (let count = 0; count < 161; count++) {
      await journal.recordCommitted('budget_probe', { count });
      await delivery.tick();
    }
    assert.equal(delivery.status().queuedBatches, 161);
    await delivery.pause(false);
    for (let count = 0; count < 160; count++) await delivery.tick(false);
    assert.equal(delivery.status().acknowledged, 160);
    assert.equal(delivery.status().retainedAcknowledgedBatches, 160);
    await journal.recordCommitted('retained_capacity_probe', {});
    await delivery.tick();
    assert.equal(delivery.status().queuedBatches, 2, 'ACK history must not consume sending slots');
    const counters = () =>
      db.prepare('SELECT permits,batches,bytes FROM daily WHERE day=?').bind(day).first();
    const before = await counters();
    for (const request of requests
      .filter(
        (item) =>
          item.status === 200 && (item.url.includes('/permits/') || item.init.method === 'PUT'),
      )
      .slice(-2))
      assert.equal((await receiver.dispatchFetch(request.url, request.init)).status, 200);
    assert.deepEqual(await counters(), before, 'same packet retry never charges again');
    await delivery.tick(false);
    assert.equal(delivery.status().transportFailure?.reason, 'daily_batch_budget');
    const reset = (day + 1) * 86400_000;
    // Near UTC midnight the bounded transport backoff can outlast the reset.
    const retryAt = delivery.status().nextAttemptAt;
    assert(retryAt >= reset && retryAt < reset + 60_000);
    await delivery.close();
    delivery = await new DiagnosticDelivery(join(root, 'client'), journal, options).initialize(
      false,
    );
    const calls = requests.length;
    await delivery.tick(false);
    assert.equal(requests.length, calls, 'restart respects the receiver reset time');
    now = retryAt + 1;
    await control();
    await delivery.tick(false);
    assert(delivery.status().acknowledged >= 161);
    assert.equal(delivery.status().transportFailure, null);
    assert.equal(delivery.status().error, null, 'retained ACK evidence is not a delivery failure');
    for (const [reason, exhaust] of [
      ['installation_byte_budget', 'UPDATE installations SET quota_bytes=16777216'],
      ['daily_byte_budget', 'UPDATE daily SET bytes=1073741824'],
    ]) {
      await db.prepare(exhaust!).run();
      await journal.recordCommitted('byte_budget_probe', { reason });
      const confirmed = delivery.status().acknowledged;
      await delivery.tick();
      assert.equal(delivery.status().transportFailure?.reason, reason);
      assert.equal(delivery.status().acknowledged, confirmed);
      now = (Math.floor(now / 86400_000) + 1) * 86400_000 + 1000;
      await control();
      await delivery.tick(false);
      assert(delivery.status().acknowledged > confirmed, 'original bytes resume after reset');
      assert.equal(delivery.status().transportFailure, null);
    }
    await control(false);
    await journal.recordCommitted('intake_pause_probe', {});
    await delivery.tick();
    assert.equal(delivery.status().transportFailure?.reason, 'intake_paused');
    await delivery.close();
    delivery = await new DiagnosticDelivery(join(root, 'client'), journal, options).initialize(
      false,
    );
    assert.equal(delivery.status().transportFailure?.reason, 'intake_paused');
    now = delivery.status().nextAttemptAt + 1;
    await control();
    await delivery.tick(false);
    assert.equal(delivery.status().transportFailure, null);
    await db.prepare('UPDATE installations SET revoked_at=?').bind(now).run();
    await journal.recordCommitted('revoked_identity_probe', {});
    const beforeRevocation = delivery.status().acknowledged;
    await delivery.tick();
    assert.equal(delivery.status().transportFailure?.reason, 'unauthorized');
    assert.equal(delivery.status().acknowledged, beforeRevocation);
    assert(delivery.status().queuedBatches > 0, 'revocation retains unconfirmed local evidence');
    console.log(
      'production receiver counters',
      await (await receiver.dispatchFetch('https://diagnostics.invalid/__test/metrics')).json(),
    );
    for (let round = 0; round < 3; round++)
      await receiver.dispatchFetch(
        `https://diagnostics.invalid/__test/cleanup?now=${now + 181 * 86400_000}`,
      );
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM batches').first())?.count, 0);
    console.log(
      'receiver counters including expiry',
      await (await receiver.dispatchFetch('https://diagnostics.invalid/__test/metrics')).json(),
    );
  } finally {
    DELIVERY_LIMITS.batches = batchLimit;
    await delivery.close();
    await journal.close();
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
