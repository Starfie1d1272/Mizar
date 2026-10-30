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

for (const change of ['none', 'authority', 'ended'] as const)
  test(`context refusal recovers only in its original live scope: ${change}`, async (t) => {
    const { outbox, event, path } = await setup(t);
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
      if (change === 'ended') bundle.program.series.status = 'completed';
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
    const restored = new ReliableOutbox(path);
    await restored.load();
    assert.equal(
      restored.getRecords().find((record) => record.status === 'rejected')?.recoveryState,
      'proof_queued',
    );
    authority = null;
  });

test('support bundle exports classified queue recovery without remote body or credentials', async (t) => {
  const { outbox, event } = await setup(t);
  const dir = await mkdtemp(join(tmpdir(), 'mizar-support-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { BusinessJournal } = await import('../src/support/business-journal.js');
  const { registerSupportRoutes } = await import('../src/support/routes.js');
  const { default: Fastify } = await import('fastify');
  const journal = new BusinessJournal(dir, () => {
    throw new Error('journal failed');
  });
  await outbox.enqueue(event('map_started', 'rejected'), now);
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async () => ({
        status: 'rejected',
        reason: 'context_stale',
        recovery: 'refresh_context',
      }),
    },
  });
  await outbox.setStartRecovery('rejected', undefined, 'refreshing');
  journal.reliable(outbox.getRecords()[0]!, 'delivery_rejected_unknown');
  journal.write('business_reliable', {
    reason: 'http_400',
    rejectionReason: 'context_stale',
    recovery: 'refresh_context',
    rawBody: 'do-not-export-secret',
    credential: 'do-not-export-secret',
  });
  await journal.flush();
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await journal.close();
  });
  registerSupportRoutes(app, {
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    logsDirectory: dir,
    flushBusinessLog: () => journal.flush(),
    runtimeSummary: () => ({}) as never,
    recorder: () => ({}) as never,
    delivery: () => [],
    hosts: () => ({ active: {}, totals: {} }) as never,
    obs: async () => undefined,
    nativeObs: async () => ({}) as never,
    gsiConfigured: false,
  });
  const response = await app.inject({
    method: 'POST',
    url: '/debug/support-bundle',
    headers: { origin: 'http://127.0.0.1:4173' },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.stringify(response.json().businessHistory);
  assert.match(body, /context_stale/);
  assert.match(body, /refresh_context/);
  assert.match(body, /refreshing/);
  assert.doesNotMatch(body, /do-not-export-secret/);
  const { gunzipSync } = await import('node:zlib');
  const archives = response.json().fullLogs.files as { volumes: { gzipBase64: string }[] }[];
  const retained = archives
    .flatMap((file) =>
      file.volumes.map((part) =>
        gunzipSync(Buffer.from(part.gzipBase64, 'base64')).toString('utf8'),
      ),
    )
    .join('\n');
  assert.match(retained, /context_stale/);
  assert.doesNotMatch(retained, /do-not-export-secret/);
});

for (const fence of ['generation_fence', 'epoch_fence'] as const)
  for (const boundaryPresent of [true, false])
    test(`${fence} requires its own pending boundary ACK: ${boundaryPresent}`, async (t) => {
      const { outbox, event } = await setup(t);
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
      t.after(() => service.close());
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

test('an acknowledged boundary needing attention cannot authorize a dependent start', async (t) => {
  const { outbox, event } = await setup(t);
  await outbox.enqueue(event('source_generation_changed', 'boundary-attention'), now);
  await outbox.enqueue(event('map_started', 'early-start'), now);
  const sent: string[] = [];
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return { status: 'accepted', outcome: 'needs_attention' };
      },
    },
  });
  assert.deepEqual(sent, ['boundary-attention']);
  assert.equal(
    outbox.getRecords().find((record) => record.event.idempotencyKey === 'boundary-attention')
      ?.receiverOutcome,
    'needs_attention',
  );
  const next = event('map_started', 'later-start');
  next.cursor.runtimeSeq++;
  assert.equal(outbox.hasUnconfirmedBoundary(next), true);
});

test('an interrupted recovery attempt remains bounded after queue restart', async (t) => {
  const { outbox, event, path } = await setup(t);
  await outbox.enqueue(event('map_started', 'start'), now);
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async () => ({
        status: 'rejected',
        reason: 'context_stale',
        recovery: 'refresh_context',
      }),
    },
  });
  assert.equal(await outbox.setStartRecovery('start', undefined, 'refreshing'), true);
  const restarted = new ReliableOutbox(path);
  await restarted.load();
  assert.equal(restarted.getRecords()[0]?.recoveryState, 'refreshing');
  assert.equal(await restarted.setStartRecovery('start', undefined, 'refreshing'), false);
});

test('a rejected start never causes queued map or series results to replay', async (t) => {
  const { outbox, event } = await setup(t);
  const start = event('map_started', 'start');
  const fixture = JSON.parse(
    await readFile(
      new URL('../../../packages/protocol/test/fixtures/reliable-event-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const end = parseReliableEventV1({
    ...fixture,
    idempotencyKey: 'end',
    cursor: { ...start.cursor, runtimeSeq: start.cursor.runtimeSeq + 1 },
  });
  const series = parseReliableEventV1({
    ...end,
    idempotencyKey: 'series',
    kind: 'series_ended',
    payload: { scoreA: 1, scoreB: 0 },
  });
  await outbox.enqueue(start, now);
  await outbox.enqueue(end, now);
  await outbox.enqueue(series, now);
  const sent: string[] = [];
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: {
      send: async (item) => {
        sent.push(item.idempotencyKey);
        return 'rejected';
      },
    },
  });
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
  assert.deepEqual(sent, ['start']);
  assert.equal(
    outbox.getRecords().find((record) => record.event.idempotencyKey === 'end')?.status,
    'superseded',
  );
  assert.equal(
    outbox.getRecords().find((record) => record.event.idempotencyKey === 'series')?.status,
    'superseded',
  );
  const proof = event('map_started', 'confirmed-new-start');
  proof.cursor.runtimeSeq += 2;
  await outbox.enqueue(proof, now);
  await outbox.flush({ now, isCurrent: () => true, sink: { send: async () => 'accepted' } });
  const future = parseReliableEventV1({
    ...end,
    idempotencyKey: 'future-end',
    cursor: { ...end.cursor, runtimeSeq: proof.cursor.runtimeSeq + 1 },
  });
  await outbox.enqueue(future, now);
  await outbox.flush({ now, isCurrent: () => true, sink: { send: async () => 'accepted' } });
  assert.equal(
    outbox.getRecords().find((record) => record.event.idempotencyKey === 'future-end')?.status,
    'accepted',
  );
});

test('scope disposition reports durable event receipts, not a local flush as an ACK', async (t) => {
  const { outbox, event } = await setup(t);
  const pending = event('map_started', 'pending');
  const other = event('map_started', 'other');
  other.cursor.liveSessionId = 'other-session';
  await outbox.enqueue(pending, now);
  await outbox.enqueue(other, now);
  await outbox.flushPending();
  const scope = {
    matchId: pending.matchId,
    producerInstanceId: pending.cursor.producerInstanceId,
    liveSessionId: pending.cursor.liveSessionId!,
  };
  assert.deepEqual(outbox.getScopeDisposition(scope), {
    pending: 1,
    accepted: 0,
    needsAttention: 0,
    rejected: 0,
    expired: 0,
    superseded: 0,
    records: [
      { kind: 'map_started', idempotencyKey: 'pending', status: 'pending', needsAttention: false },
    ],
  });
  await outbox.flush({
    now,
    isCurrent: () => true,
    sink: { send: async () => ({ status: 'accepted', outcome: 'needs_attention' }) },
  });
  const disposition = outbox.getScopeDisposition(scope);
  assert.equal(disposition.accepted, 1);
  assert.equal(disposition.needsAttention, 1);
  assert.equal(disposition.pending, 0);
});
