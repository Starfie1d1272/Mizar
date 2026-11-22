import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { OutboxWorkerClient } from '../src/output/outbox-worker-client.js';

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
  const createProgramHarness = (reference: ReliableEventV1, timeFn: () => Date) => {
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
    const observe = (service: {
      setCurrent: (b: never, m: never) => void;
      afterRuntimeMutation: (r: never, b: never, m: never) => void;
    }) => {
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
            programTelemetry: { receive: { receivedAt: timeFn().toISOString() } },
          },
        } as never,
        bundle as never,
        binding as never,
      );
    };
    return { cursor, binding, bundle, observe };
  };
  return {
    outbox: owner,
    event,
    cleanup,
    createProgramHarness,
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
    const { outbox, event, cleanup, createProgramHarness, restart } = await setup(t);
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
    const {
      cursor,
      binding,
      bundle,
      observe: observeBase,
    } = createProgramHarness(event('map_started', 'template'), () => time);
    const observe = () => observeBase(service);
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
    const { outbox, event, cleanup, createProgramHarness } = await setup(t);
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
    const { cursor, binding, bundle, observe } = createProgramHarness(start, () => now);
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
    observe(service);
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

test('concurrent capture seals remain successful after restart', async (t) => {
  const { outbox, event, restart } = await setup(t);
  const sample = event('map_started', 'capture');
  const source = {
    baseUrl: 'https://example.com',
    competitionId: sample.competitionId,
    installationId: 'installation-1',
    authorityRevision: 1,
    matchId: sample.matchId,
    producerInstanceId: sample.cursor.producerInstanceId,
    liveSessionId: sample.cursor.liveSessionId!,
  };
  const reference = outbox.createCaptureReference(sample.cursor);
  await outbox.armCapture(source, reference);
  outbox.activateCapture(source, sample.cursor);
  assert.deepEqual(
    await Promise.all([
      outbox.sealCapture(source, sample.cursor),
      outbox.sealCapture(source, sample.cursor),
    ]),
    [true, true],
  );
  const restored = await restart();
  assert.equal(restored.captureCoverage(source).state, 'sealed');
});

test('a map result requiring attention prevents its snapshot from being sent', async (t) => {
  const { outbox, event, restart } = await setup(t);
  const base = event('map_started', 'result');
  const end = parseReliableEventV1({
    ...base,
    kind: 'map_ended',
    payload: { scoreA: 13, scoreB: 10, scoreCT: 13, scoreT: 10 },
  });
  const snapshot = parseReliableEventV1({
    ...base,
    kind: 'map_player_snapshot',
    idempotencyKey: 'snapshot',
    payload: {
      mapEndedKey: end.idempotencyKey,
      players: [
        { sourcePlayerId: 'player', canonicalPlayerId: null, kills: 1, assists: 0, deaths: 0 },
      ],
    },
  });
  await outbox.enqueue(end, now);
  await outbox.enqueue(snapshot, now);
  const sent: string[] = [];
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.kind);
        return { status: 'accepted', outcome: 'needs_attention' };
      },
    },
  });
  assert.deepEqual(sent, ['map_ended']);
  const restored = await restart();
  const record = restored.getRecords().find((item) => item.event.idempotencyKey === 'snapshot');
  assert.equal(record?.status, 'superseded');
  assert.equal(record?.supersessionReason, 'map_end_unavailable');
});

test('a durable map result and its snapshot keep their original cursor across a source change', async (t) => {
  const { outbox, event, restart, cleanup } = await setup(t);
  const { OutputService } = await import('../src/output/service.js');
  const base = event('map_started', 'result-before-reconnect');
  const end = parseReliableEventV1({
    ...base,
    kind: 'map_ended',
    payload: { scoreA: 13, scoreB: 10, scoreCT: 13, scoreT: 10 },
  });
  const snapshot = parseReliableEventV1({
    ...base,
    kind: 'map_player_snapshot',
    idempotencyKey: 'snapshot-before-reconnect',
    payload: {
      mapEndedKey: end.idempotencyKey,
      players: [
        { sourcePlayerId: 'player', canonicalPlayerId: null, kills: 1, assists: 0, deaths: 0 },
      ],
    },
  });
  await outbox.enqueue(end, now);
  await outbox.enqueue(snapshot, now);
  const restored = await restart();
  const sent: ReliableEventV1[] = [];
  const service = new OutputService({
    outbox: restored,
    now: () => now,
    sink: {
      async send(item) {
        sent.push(item);
        return 'accepted';
      },
    },
  });
  cleanup.push(() => service.close());
  service.setCurrent(
    {
      program: {
        cursor: {
          ...base.cursor,
          runtimeSeq: base.cursor.runtimeSeq + 1,
          programSourceGeneration: base.cursor.programSourceGeneration + 1,
        },
        players: [],
        match: { matchId: base.matchId },
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
        map: { phase: 'warmup', name: base.mapName },
        series: { status: 'live' },
      },
    } as never,
    {
      origin: 'online',
      freshness: 'fresh',
      manifest: { revision: base.contextRevision },
      context: { matchId: base.matchId },
    } as never,
  );
  await service.retry();
  assert.deepEqual(sent, [end, snapshot]);
});

test('missing worker reply fails the active owner and later operations report the same uncertainty', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-worker-deadline-'));
  const failures: string[] = [];
  const client = new OutboxWorkerClient(join(directory, 'outbox.json'), (error) => {
    failures.push(error.message);
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = client.request('load');
  const check = assert.rejects(pending, /outbox_worker_reply_timeout:load/);
  t.mock.timers.tick(30_000);
  await check;
  await assert.rejects(client.request('captureCapacity'), /outbox_worker_reply_timeout:load/);
  assert.deepEqual(failures, ['outbox_worker_reply_timeout:load']);
});

test('unconfirmed capture interval transitions to durable unknown without blocking subsequent independent matches', async (t) => {
  const { outbox, event, restart } = await setup(t);
  const first = event('map_started', 'match-1');
  const source1 = {
    baseUrl: 'https://example.com',
    competitionId: first.competitionId,
    installationId: 'installation-1',
    authorityRevision: 1,
    matchId: first.matchId,
    producerInstanceId: first.cursor.producerInstanceId,
    liveSessionId: first.cursor.liveSessionId!,
  };
  await outbox.armCapture(source1, outbox.createCaptureReference(first.cursor));
  outbox.activateCapture(source1, first.cursor);
  await outbox.isolateRevokedSource(source1);
  // Reserving a capture ticket against a revoked source fails without committing to SQLite.
  await assert.rejects(
    outbox.enqueue(first, now, undefined, undefined, undefined, undefined, source1),
    /outbox_source_revoked/,
  );
  // Sealing reconciles the unconfirmable interval into durable unknown instead of wedging armed forever.
  assert.equal(await outbox.sealCapture(source1, first.cursor), false);
  assert.equal(outbox.captureCoverage(source1).state, 'unknown');
  assert.equal(outbox.hasDurableUnknownCapture(source1), true);

  // A subsequent independent match arms, captures, and seals cleanly.
  const secondBase = event('map_started', 'match-2');
  const second = {
    ...secondBase,
    matchId: 'match-2',
    cursor: { ...secondBase.cursor, liveSessionId: 'session-2' },
  };
  const source2 = { ...source1, matchId: 'match-2', liveSessionId: 'session-2' };
  await outbox.armCapture(source2, outbox.createCaptureReference(second.cursor));
  outbox.activateCapture(source2, second.cursor);
  assert.equal(
    await outbox.enqueue(second, now, undefined, undefined, undefined, undefined, source2),
    true,
  );
  assert.equal(await outbox.sealCapture(source2, second.cursor), true);
  assert.equal(outbox.captureCoverage(source2).state, 'sealed');

  const restored = await restart();
  assert.equal(restored.captureCoverage(source1).state, 'unknown');
  assert.equal(restored.captureCoverage(source2).state, 'sealed');
});

test('late async enqueue failure and known-source boundary loss stay isolated to the failing match', async (t) => {
  const { outbox, event, cleanup, createProgramHarness } = await setup(t);
  const { OutputService } = await import('../src/output/service.js');

  // 1. Known-source boundary capture loss on sourceA does not block sourceB capture/seal.
  const first = event('map_started', 'match-a');
  const sourceA = {
    baseUrl: 'https://example.com',
    competitionId: first.competitionId,
    installationId: 'installation-1',
    authorityRevision: 1,
    matchId: first.matchId,
    producerInstanceId: first.cursor.producerInstanceId,
    liveSessionId: first.cursor.liveSessionId!,
  };
  await outbox.armCapture(sourceA, outbox.createCaptureReference(first.cursor));
  outbox.activateCapture(sourceA, first.cursor);
  // Known-source boundary capture failure transitions sourceA to unknown without setting global boundaryCaptureLost.
  await assert.rejects(
    outbox.captureBoundaries(
      [{ invalid: true }] as never,
      [],
      undefined,
      false,
      now,
      {
        matchId: first.matchId,
        producerInstanceId: first.cursor.producerInstanceId,
        liveSessionId: first.cursor.liveSessionId!,
        ownerFingerprint: 'owner-a',
        runtimeSeq: first.cursor.runtimeSeq,
        programSourceGeneration: first.cursor.programSourceGeneration,
        mapEpoch: first.cursor.mapEpoch,
        authorityFingerprint: 'auth-a',
      },
      sourceA,
    ),
  );
  assert.equal(outbox.getBoundaryCaptureRecovery().lost, false);
  assert.equal(await outbox.sealCapture(sourceA, first.cursor), false);
  assert.equal(outbox.captureCoverage(sourceA).state, 'unknown');
  const sourceB = { ...sourceA, matchId: 'match-b', liveSessionId: 'session-b' };
  const secondBase = event('map_started', 'match-b');
  const second = {
    ...secondBase,
    matchId: 'match-b',
    cursor: { ...secondBase.cursor, liveSessionId: 'session-b' },
  };
  await outbox.armCapture(sourceB, outbox.createCaptureReference(second.cursor));
  outbox.activateCapture(sourceB, second.cursor);
  assert.equal(
    await outbox.enqueue(second, now, undefined, undefined, undefined, undefined, sourceB),
    true,
  );
  assert.equal(await outbox.sealCapture(sourceB, second.cursor), true);

  // 2. Late async enqueue failure on Match A after operator switches to Match B only quarantines Match A.
  const time = now;
  let rejectNext = false;
  const service = new OutputService({
    outbox,
    now: () => time,
  });
  cleanup.push(() => service.close());
  const matchA = createProgramHarness(first, () => time);
  const matchB = createProgramHarness(second, () => time);
  const origEnqueue = outbox.enqueue.bind(outbox);
  outbox.enqueue = (async (...args: Parameters<typeof outbox.enqueue>) => {
    if (rejectNext) {
      rejectNext = false;
      throw new Error('late_async_enqueue_failure');
    }
    return origEnqueue(...args);
  }) as typeof outbox.enqueue;

  rejectNext = true;
  matchA.observe(service);
  // Immediately switch workbench to Match B before Match A's rejected promise settles.
  service.setCurrent(matchB.bundle as never, matchB.binding as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.notEqual(service.currentStatus().blockedReason, 'output_quarantined');
  // Switching back to Match A shows Match A itself is quarantined.
  service.setCurrent(matchA.bundle as never, matchA.binding as never);
  assert.equal(service.currentStatus().snapshot, null);
  assert.equal(service.currentStatus().blockedReason, 'output_quarantined');
});
