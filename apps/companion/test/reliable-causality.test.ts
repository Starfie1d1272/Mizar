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
  let owner = new ReliableOutbox(path);
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    await owner.close();
    await rm(dir, { recursive: true, force: true });
  });
  await owner.load();
  return {
    outbox: owner,
    event,
    cleanup,
    restart: async () => {
      await owner.close();
      owner = new ReliableOutbox(path);
      await owner.load();
      return owner;
    },
  };
}

test('output waits for a new observation after the preserved generation boundary is acknowledged', async (t) => {
  const { outbox, event, cleanup } = await setup(t);
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
  cleanup.push(() => service.close());
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
  const { outbox, event, restart } = await setup(t);
  const { businessEvidence } = await import('../src/support/business-evidence.js');
  const rejection = {
    status: 'rejected' as const,
    reason: 'context_stale' as const,
    recovery: 'refresh_context' as const,
    requestId: 'c8f5fa6d-e075-470d-a3d4-fc24ce646fa5',
  };
  await outbox.enqueue(event('map_started', 'rejected'), now);
  await outbox.flush({ now, isCurrent: () => true, sink: { send: async () => rejection } });
  const restored = await restart();
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

for (const change of ['none', 'authority'] as const)
  test(`context refusal recovers only in its original live scope: ${change}`, async (t) => {
    const { outbox, event, cleanup, restart } = await setup(t);
    const { OutputService } = await import('../src/output/service.js');
    let time = now;
    let outcome: 'reject' | 'accept' = 'reject';
    let authority: string | null = 'authority-1';
    let refreshes = 0;
    const sent: string[] = [];
    const service = new OutputService({
      outbox,
      now: () => time,
      authorityScope: () => authority,
      sink: {
        send: async (item) => {
          sent.push(item.idempotencyKey);
          return outcome === 'reject'
            ? { status: 'rejected', reason: 'context_stale', recovery: 'refresh_context' }
            : 'accepted';
        },
      },
    });
    cleanup.push(() => service.close());
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
        cursor: { ...cursor },
        match: { matchId: reference.matchId },
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
        map: { phase: 'live', name: reference.mapName },
        players,
        series: { status: 'live', currentMapOrder: 1, maps: [] },
      },
      operator: { activeLineup: { ctCount: 5, tCount: 5 }, identity: { state: 'mismatch' } },
      identity: { issues: [] },
    };
    const observe = () => {
      bundle.program.cursor = { ...cursor };
      service.setCurrent(bundle as never, binding as never);
      service.afterRuntimeMutation(
        {
          disposition: { kind: 'accepted', reason: 'contiguous' },
          transitions: [],
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
        } as never,
        bundle as never,
        binding as never,
      );
    };
    service.setContextRecoveryHandler(async () => {
      refreshes++;
      if (change === 'authority') authority = 'authority-2';
      binding.manifest.revision = 'refreshed';
      service.setCurrent(bundle as never, binding as never);
      return true;
    });
    observe();
    await outbox.flushPending();
    await service.retry();
    assert.equal(refreshes, 1);
    assert.equal(sent.length, 1);
    if (change !== 'none') {
      assert.equal(outbox.getRecords()[0]?.recoveryState, 'blocked');
      cursor.runtimeSeq++;
      cursor.programReceiveSequence!++;
      observe();
      await outbox.flushPending();
      await service.retry();
      assert.equal(sent.length, 1);
      assert.equal(refreshes, 1);
      return;
    }
    assert.equal(outbox.getRecords()[0]?.recoveryState, 'awaiting_observation');
    await service.retry();
    assert.equal(sent.length, 1);
    cursor.runtimeSeq++;
    cursor.programReceiveSequence!++;
    time = new Date(time.getTime() + 10);
    outcome = 'accept';
    observe();
    await outbox.flushPending();
    assert.equal(
      outbox.getRecords().find((record) => record.status === 'rejected')?.recoveryState,
      'proof_queued',
    );
    await service.retry();
    assert.equal(sent.length, 2);
    cursor.runtimeSeq++;
    cursor.programReceiveSequence!++;
    observe();
    await outbox.flushPending();
    await service.retry();
    assert.equal(sent.length, 2);
    assert.equal(refreshes, 1);
    await service.close();
    const restored = await restart();
    assert.equal(
      restored.getRecords().find((record) => record.status === 'rejected')?.recoveryState,
      'proof_queued',
    );
    authority = null;
  });

for (const [fence, boundaryPresent] of [
  ['generation_fence', true],
  ['epoch_fence', false],
] as const)
  test(`${fence} requires its own pending boundary ACK: ${boundaryPresent}`, async (t) => {
    const { outbox, event, cleanup } = await setup(t);
    const { OutputService } = await import('../src/output/service.js');
    const start = event('map_started', 'old-start');
    const lineup = Array.from({ length: 10 }, (_, i) => String(76561198000000000n + BigInt(i)));
    await outbox.enqueue(start, now, undefined, lineup);
    await outbox.flush({
      now,
      isCurrent: () => true,
      sink: {
        send: async () => ({
          status: 'rejected',
          reason: fence,
          recovery: 'reconcile',
        }),
      },
    });
    if (boundaryPresent)
      await outbox.enqueue(
        event(
          fence === 'generation_fence' ? 'source_generation_changed' : 'map_epoch_changed',
          'boundary',
        ),
        now,
      );
    const cursor = { ...start.cursor };
    const players = lineup.map((id) => ({
      lineupEvidence: 'current',
      sourcePlayerId: id,
      canonicalPlayerId: null,
    }));
    const binding = {
      origin: 'online',
      freshness: 'fresh',
      manifest: { revision: start.contextRevision },
      context: {
        matchId: start.matchId,
        competition: { competitionId: start.competitionId },
        entrants: { a: { entryId: start.entryAId }, b: { entryId: start.entryBId } },
      },
    };
    const bundle = {
      program: {
        cursor: { ...cursor },
        match: { matchId: start.matchId },
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
        map: { phase: 'live', name: start.mapName },
        players,
        series: { status: 'live', currentMapOrder: 1, maps: [] },
      },
      operator: { activeLineup: { ctCount: 5, tCount: 5 }, identity: { state: 'mismatch' } },
      identity: { issues: [] },
    };
    const sent: string[] = [];
    const progress: string[] = [];
    const service = new OutputService({
      outbox,
      now: () => now,
      authorityScope: () => 'authority-1',
      onRecoveryProgress: (_event, state) => progress.push(state),
      sink: {
        send: async (item) => {
          sent.push(item.idempotencyKey);
          return 'accepted';
        },
      },
    });
    cleanup.push(() => service.close());
    service.setCurrent(bundle as never, binding as never);
    await service.retry();
    assert.equal(
      outbox.getRecords().find((record) => record.event.idempotencyKey === 'old-start')
        ?.recoveryState,
      boundaryPresent ? 'awaiting_observation' : 'blocked',
    );
    assert.deepEqual(sent, boundaryPresent ? ['boundary'] : []);
    if (!boundaryPresent) assert.ok(progress.includes('continuity_chain_missing'));
    cursor.runtimeSeq++;
    cursor.programReceiveSequence!++;
    bundle.program.cursor = { ...cursor };
    service.setCurrent(bundle as never, binding as never);
    service.afterRuntimeMutation(
      {
        disposition: { kind: 'accepted', reason: 'contiguous' },
        transitions: [],
        state: {
          map: { name: start.mapName },
          programSource: {
            lastAccepted: {
              generation: cursor.programSourceGeneration,
              sequence: cursor.programReceiveSequence,
            },
          },
          programTelemetry: { receive: { receivedAt: now.toISOString() } },
        },
      } as never,
      bundle as never,
      binding as never,
    );
    await outbox.flushPending();
    await service.retry();
    assert.equal(sent.length, boundaryPresent ? 2 : 0);
  });

test('source settlement waits for a reliable request already in flight', async (t) => {
  const { outbox, event, cleanup } = await setup(t);
  const { OutputService } = await import('../src/output/service.js');
  const pending = event('map_started', 'release-inflight');
  await outbox.enqueue(pending, now);
  let acknowledge!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sending = outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: () =>
        new Promise<'accepted'>((resolve) => {
          acknowledge = () => resolve('accepted');
          started();
        }),
    },
  });
  await begun;
  const service = new OutputService({ outbox, now: () => now });
  cleanup.push(() => service.close());
  let settled = false;
  const settling = service
    .settleSourceForRelease({
      matchId: pending.matchId,
      producerInstanceId: pending.cursor.producerInstanceId,
      liveSessionId: pending.cursor.liveSessionId!,
    })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  acknowledge();
  await sending;
  assert.equal(await settling, true);
});
