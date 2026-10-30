import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';

const now = new Date('2026-09-28T00:00:10.000Z');
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-causality-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = JSON.parse(
    await readFile(
      new URL('../../../packages/protocol/test/fixtures/reliable-event-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const event = (
    kind: 'source_generation_changed' | 'map_epoch_changed' | 'map_started',
    key: string,
  ): ReliableEventV1 =>
    parseReliableEventV1({
      ...fixture,
      idempotencyKey: key,
      kind,
      cursor: {
        ...fixture.cursor,
        liveSessionId: 'session-1',
        programSourceGeneration: 2,
        runtimeSeq: 10,
      },
      payload:
        kind === 'source_generation_changed'
          ? { previousSourceGeneration: 1 }
          : kind === 'map_epoch_changed'
            ? { previousMapEpoch: 0, reason: null }
            : {},
    });
  const path = join(dir, 'outbox.json');
  const outbox = new ReliableOutbox(path);
  await outbox.load();
  return { outbox, path, event };
}

test('generation retry fences start across backoff and restart until its original ACK', async (t) => {
  const { outbox, path, event } = await setup(t);
  const generation = event('source_generation_changed', 'generation');
  const start = event('map_started', 'start');
  await outbox.enqueue(generation, now);
  await outbox.enqueue(start, now);
  const sent: string[] = [];
  const invalidated = await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return 'retry';
      },
    },
  });
  assert.deepEqual(invalidated, ['start']);
  assert.deepEqual(sent, ['generation']);
  const restarted = new ReliableOutbox(path);
  await restarted.load();
  await restarted.flush({
    now: new Date(now.getTime() + 500),
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return 'accepted';
      },
    },
  });
  assert.deepEqual(sent, ['generation']);
  await restarted.flush({
    now: new Date(now.getTime() + 1000),
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return 'accepted';
      },
    },
  });
  assert.deepEqual(sent, ['generation', 'generation']);
  assert.equal(
    restarted.getRecords().find((record) => record.event.idempotencyKey === 'start')?.status,
    'superseded',
  );
  assert.deepEqual(
    restarted.getRecords().find((record) => record.event.idempotencyKey === 'generation')?.event,
    generation,
  );
  const proof = event('map_started', 'new-proof');
  proof.cursor.runtimeSeq += 1;
  await restarted.enqueue(proof, new Date(now.getTime() + 1001));
  await restarted.flush({
    now: new Date(now.getTime() + 1001),
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return 'accepted';
      },
    },
  });
  assert.deepEqual(sent, ['generation', 'generation', 'new-proof']);
});

test('a rejected or blocked continuity boundary never sends dependent start', async (t) => {
  const { outbox, event } = await setup(t);
  await outbox.enqueue(event('map_epoch_changed', 'epoch'), now);
  await outbox.enqueue(event('map_started', 'start'), now);
  const sent: string[] = [];
  const sink = {
    send: async (item: ReliableEventV1) => {
      sent.push(item.idempotencyKey);
      return 'rejected' as const;
    },
  };
  await outbox.flush({
    now,
    isCurrent: () => true,
    canSend: (item) => item.kind !== 'map_epoch_changed',
    sink,
  });
  assert.deepEqual(sent, []);
  await outbox.flush({ now, isCurrent: () => true, sink });
  await outbox.flush({ now, isCurrent: () => true, sink });
  assert.deepEqual(sent, ['epoch']);
  assert.deepEqual(
    outbox.getRecords().map((record) => record.status),
    ['rejected', 'superseded'],
  );
});

test('failed fences survive receipt rotation but do not block another session', async (t) => {
  const { outbox, event } = await setup(t);
  await outbox.enqueue(event('source_generation_changed', 'failed'), now);
  await outbox.flush({ now, isCurrent: () => true, sink: { send: async () => 'rejected' } });
  for (let i = 0; i < 70; i++) {
    const other = event('map_started', `other-${i}`);
    other.cursor.liveSessionId = 'another-session';
    other.cursor.runtimeSeq += i;
    await outbox.enqueue(other, now);
    await outbox.flush({ now, isCurrent: () => true, sink: { send: async () => 'accepted' } });
  }
  assert.equal(
    outbox.getRecords().find((record) => record.event.idempotencyKey === 'failed')?.status,
    'rejected',
  );
  await outbox.enqueue(event('map_started', 'dependent'), now);
  const sent: string[] = [];
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return 'accepted';
      },
    },
  });
  assert.deepEqual(sent, []);
});

test('output waits for a new observation after the preserved generation boundary is acknowledged', async (t) => {
  const { outbox, event } = await setup(t);
  const { OutputService } = await import('../src/output/service.js');
  let time = now;
  let accepts = false;
  const sent: string[] = [];
  const diagnostics: string[] = [];
  const service = new OutputService({
    onDiagnostic: (code) => diagnostics.push(code),
    outbox,
    now: () => time,
    sink: {
      send: async (item) => {
        sent.push(item.kind);
        return accepts ? 'accepted' : 'retry';
      },
    },
  });
  t.after(() => service.close());
  const reference = event('map_started', 'template');
  const cursor = { ...reference.cursor };
  const players = Array.from({ length: 10 }, (_, i) => ({
    lineupEvidence: 'current',
    sourcePlayerId: String(76561198000000000n + BigInt(i)),
    canonicalPlayerId: null,
  }));
  const binding = {
    origin: 'online',
    freshness: 'fresh',
    manifest: { revision: reference.contextRevision },
    context: {
      matchId: reference.matchId,
      competition: { competitionId: reference.competitionId },
      entrants: { a: { entryId: reference.entryAId }, b: { entryId: reference.entryBId } },
    },
  };
  const bundle = {
    program: {
      cursor,
      match: { matchId: reference.matchId },
      status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
      map: { phase: 'live', name: reference.mapName },
      players,
      series: { status: 'live', currentMapOrder: 1, maps: [] },
    },
    operator: { activeLineup: { ctCount: 5, tCount: 5 }, identity: { state: 'mismatch' } },
    identity: { issues: [] },
  };
  const result = (reason: string, epochChanged = false) => ({
    disposition: { kind: 'accepted', reason },
    transitions: epochChanged
      ? [
          {
            kind: 'map_execution_changed',
            previousMapEpoch: cursor.mapEpoch - 1,
            reason: 'map-change',
            at: { utc: time.toISOString() },
          },
        ]
      : [],
    state: {
      map: { name: reference.mapName },
      programSource: {
        lastAccepted: {
          generation: cursor.programSourceGeneration,
          sequence: cursor.programReceiveSequence,
        },
      },
      programTelemetry: { receive: { receivedAt: time.toISOString() } },
    },
  });
  service.setCurrent(bundle as never, binding as never);
  service.afterRuntimeMutation(
    result('source-generation-advanced') as never,
    bundle as never,
    binding as never,
  );
  await outbox.flushPending();
  await service.retry();
  assert.deepEqual(sent, ['source_generation_changed']);
  binding.manifest.revision = 'refreshed';
  cursor.mapEpoch += 1;
  cursor.runtimeSeq += 1;
  cursor.programReceiveSequence! += 1;
  bundle.program.cursor = { ...cursor };
  service.setCurrent(bundle as never, binding as never);
  service.afterRuntimeMutation(
    result('contiguous', true) as never,
    bundle as never,
    binding as never,
  );
  await outbox.flushPending();
  assert.equal(
    outbox.getRecords().some((record) => record.event.kind === 'map_started'),
    false,
  );
  accepts = true;
  time = new Date(now.getTime() + 1000);
  await service.retry();
  assert.deepEqual(sent, [
    'source_generation_changed',
    'source_generation_changed',
    'map_epoch_changed',
  ]);
  cursor.runtimeSeq += 1;
  cursor.programReceiveSequence! += 1;
  bundle.program.cursor = { ...cursor };
  service.setCurrent(bundle as never, binding as never);
  service.afterRuntimeMutation(result('contiguous') as never, bundle as never, binding as never);
  await outbox.flushPending();
  cursor.runtimeSeq += 1;
  cursor.programReceiveSequence! += 1;
  bundle.program.cursor = { ...cursor };
  service.setCurrent(bundle as never, binding as never);
  service.afterRuntimeMutation(result('contiguous') as never, bundle as never, binding as never);
  await outbox.flushPending();
  assert.equal(
    outbox.getRecords().filter((record) => record.event.kind === 'map_started').length,
    1,
  );
  await service.retry();
  assert.deepEqual(sent, [
    'source_generation_changed',
    'source_generation_changed',
    'map_epoch_changed',
    'map_started',
  ]);
});

test('classified rejection persists and diagnostic evidence discards raw response fields', async (t) => {
  const { outbox, path, event } = await setup(t);
  const { businessEvidence } = await import('../src/support/business-evidence.js');
  const rejection = {
    status: 'rejected' as const,
    reason: 'context_stale' as const,
    recovery: 'refresh_context' as const,
    requestId: 'c8f5fa6d-e075-470d-a3d4-fc24ce646fa5',
  };
  await outbox.enqueue(event('map_started', 'rejected'), now);
  await outbox.flush({ now, isCurrent: () => true, sink: { send: async () => rejection } });
  const restored = new ReliableOutbox(path);
  await restored.load();
  assert.deepEqual(restored.getRecords()[0]?.rejection, rejection);
  const safe = businessEvidence({
    rejectionReason: rejection.reason,
    recovery: rejection.recovery,
    requestId: rejection.requestId,
    rawResponse: 'secret',
    credential: 'secret',
  });
  assert.equal(safe.rejectionReason, 'context_stale');
  assert.equal(safe.recovery, 'refresh_context');
  assert.equal(safe.requestId, rejection.requestId);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});
