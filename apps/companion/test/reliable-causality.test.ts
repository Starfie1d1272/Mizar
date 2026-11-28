import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { RuntimeReduceResult } from '@mizar/core/runtime';
import type { ReliableEventV2 } from '@mizar/protocol/output';
import type { MatchContextBinding } from '../src/match-context/index.js';
import type { ProjectionBundle } from '../src/projections/projection-coordinator.js';
import { createHttpReliableSink } from '../src/output/http-sink.js';
import { buildReliableEventV2 } from '../src/output/projector.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { OutputService } from '../src/output/service.js';

function makeBinding(revision = 'rev-1'): MatchContextBinding {
  return {
    origin: 'online',
    freshness: 'fresh',
    manifest: { revision },
    context: {
      matchId: 'match-1',
      format: 'bo3',
      competition: { competitionId: 'comp-1', slug: 'cup', name: 'Cup', themeColor: null },
      entrants: {
        a: { entryId: 'entry-a', name: 'Team A', shortName: 'A', players: [] },
        b: { entryId: 'entry-b', name: 'Team B', shortName: 'B', players: [] },
      },
      maps: [
        { mapOrder: 1, mapId: 'map-1', mapName: 'de_ancient' },
        { mapOrder: 2, mapId: 'map-2', mapName: 'de_nuke' },
      ],
    },
  } as unknown as MatchContextBinding;
}

function makePlayers() {
  return Array.from({ length: 10 }, (_, index) => ({
    sourcePlayerId: `7656119800000000${index}`,
    canonicalPlayerId: `player-${index}`,
    identityEvidence: 'canonical' as const,
    lineupEvidence: 'current' as const,
    displayName: `Player ${index}`,
    side: index < 5 ? ('CT' as const) : ('T' as const),
    lifeState: 'alive' as const,
    state: null,
    weapons: [],
    matchStats: { kills: 15 + index, assists: 3, deaths: 10 + index },
    liveAdr: 85,
    completedAdr: 85,
  }));
}

function makeBundle(overrides: {
  mapName?: string;
  mapOrder?: number;
  mapPhase?: string;
  seriesStatus?: 'live' | 'completed';
  scoreA?: number;
  scoreB?: number;
  scoreCT?: number;
  scoreT?: number;
  runtimeSeq?: number;
  mapEpoch?: number;
  completedMap?: { mapId: string; mapName: string; a: number; b: number };
}): ProjectionBundle {
  const mapOrder = overrides.mapOrder ?? 1;
  const mapName = overrides.mapName ?? 'de_ancient';
  const maps = [
    {
      mapOrder: 1,
      mapId: 'map-1',
      mapName: 'de_ancient',
      status: mapOrder > 1 || overrides.completedMap?.mapId === 'map-1' ? 'completed' : 'live',
      finalScore:
        overrides.completedMap?.mapId === 'map-1'
          ? { a: overrides.completedMap.a, b: overrides.completedMap.b }
          : mapOrder > 1
            ? { a: 13, b: 8 }
            : null,
    },
    {
      mapOrder: 2,
      mapId: 'map-2',
      mapName: 'de_nuke',
      status:
        overrides.completedMap?.mapId === 'map-2'
          ? 'completed'
          : mapOrder === 2
            ? 'live'
            : 'upcoming',
      finalScore:
        overrides.completedMap?.mapId === 'map-2'
          ? { a: overrides.completedMap.a, b: overrides.completedMap.b }
          : null,
    },
  ];
  return {
    program: {
      cursor: {
        producerInstanceId: 'prod-1',
        liveSessionId: 'sess-1',
        runtimeSeq: overrides.runtimeSeq ?? 10,
        programSourceGeneration: 1,
        programReceiveSequence: overrides.runtimeSeq ?? 10,
        mapEpoch: overrides.mapEpoch ?? 1,
      },
      match: { matchId: 'match-1' },
      status: { telemetry: 'fresh', context: 'fresh', identity: 'matched' },
      series: {
        status: overrides.seriesStatus ?? 'live',
        score: { a: overrides.scoreA ?? 0, b: overrides.scoreB ?? 0 },
        currentMapOrder: mapOrder,
        roundHistory: null,
        bindingState: 'bound',
        maps,
      },
      map: {
        name: mapName,
        phase: overrides.mapPhase ?? 'live',
        roundNumber: 1,
        score: { ct: overrides.scoreCT ?? 13, t: overrides.scoreT ?? 8 },
      },
      round: { phase: 'live' },
      clock: null,
      teams: {
        ct: { entryId: 'entry-a', name: 'Team A', mode: 'canonical' },
        t: { entryId: 'entry-b', name: 'Team B', mode: 'canonical' },
      },
      players: makePlayers(),
      observedPlayerSourceId: null,
      bomb: null,
    },
    radar: {
      cursor: {
        producerInstanceId: 'prod-1',
        liveSessionId: 'sess-1',
        runtimeSeq: overrides.runtimeSeq ?? 10,
        programSourceGeneration: 1,
        programReceiveSequence: overrides.runtimeSeq ?? 10,
        mapEpoch: overrides.mapEpoch ?? 1,
      },
      mapName,
      telemetryFreshness: 'fresh',
      identityState: 'matched',
      players: [],
      bomb: null,
      utility: [],
    },
    operator: {
      activeLineup: {
        ctCount: 5,
        tCount: 5,
        state: 'complete',
        retainedCount: 0,
        sourceGeneration: 1,
        mapEpoch: overrides.mapEpoch ?? 1,
      },
      identity: {
        state: 'matched',
        sideMapping: { a: 'CT', b: 'T' },
        capabilities: { canonicalTeamBranding: true },
      },
      runtime: { lastAccepted: { receiveSequence: overrides.runtimeSeq ?? 10 } },
    },
    identity: { issues: [], players: [], unresolved: [] },
  } as unknown as ProjectionBundle;
}

function makeReduceResult(
  utc: string,
  transitions: RuntimeReduceResult['transitions'],
): RuntimeReduceResult {
  return {
    disposition: { kind: 'accepted' },
    state: { programTelemetry: { receive: { receivedAt: utc } } },
    transitions,
  } as unknown as RuntimeReduceResult;
}

test('map_ended across unrelated maps and offline workbench exit delivers map_ended with inline players and series_ended on reconnect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-outbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let nowMs = Date.parse('2026-11-28T10:00:00.000Z');
  let online = true;
  const received: { event: ReliableEventV2; authority: string | null; auth: string | null }[] = [];

  const sink = createHttpReliableSink({
    url: 'https://rivalhub.example.com/api/mizar/reliable-v2',
    token: 'secret-token',
    fetch: async (_url, init) => {
      if (!online) throw new Error('ECONNREFUSED');
      const headers = new Headers(init?.headers);
      const event = JSON.parse(String(init?.body)) as ReliableEventV2;
      received.push({
        event,
        authority: headers.get('x-rivalhub-authority'),
        auth: headers.get('authorization'),
      });
      return Response.json({ ok: true });
    },
  });

  const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
  const output = new OutputService({
    outbox,
    sink,
    now: () => new Date(nowMs),
    exactSource: () => ({
      baseUrl: 'https://rivalhub.example.com',
      competitionId: 'comp-1',
      installationId: 'inst-1',
      matchId: 'match-1',
      producerInstanceId: 'prod-1',
      liveSessionId: 'sess-1',
      authorityRevision: 7,
    }),
  });
  t.after(() => output.close());
  await output.start();

  const binding = makeBinding();
  // Map 1 ends while online.
  const map1Live = makeBundle({ mapName: 'de_ancient', mapOrder: 1, mapPhase: 'live' });
  output.setCurrent(map1Live, binding);
  output.beforeRuntimeMutation();
  const map1End = makeBundle({
    mapName: 'de_ancient',
    mapOrder: 1,
    mapPhase: 'gameover',
    scoreA: 1,
    scoreB: 0,
    scoreCT: 13,
    scoreT: 8,
    completedMap: { mapId: 'map-1', mapName: 'de_ancient', a: 13, b: 8 },
  });
  output.afterRuntimeMutation(
    makeReduceResult('2026-11-28T10:01:00.000Z', [
      { kind: 'map_ended', at: { utc: '2026-11-28T10:01:00.000Z' } } as never,
    ]),
    map1End,
    binding,
  );
  await output.retry();
  assert.ok(received.some((r) => r.event.kind === 'map_ended' && r.event.mapName === 'de_ancient'));

  // Switch through unrelated maps (de_dust2, de_mirage, de_inferno) without throwing or breaking state.
  for (const fillerMap of ['de_dust2', 'de_mirage', 'de_inferno']) {
    output.beforeRuntimeMutation();
    output.afterRuntimeMutation(
      makeReduceResult('2026-11-28T10:05:00.000Z', []),
      makeBundle({ mapName: fillerMap, mapOrder: 2, mapPhase: 'warmup', scoreA: 1, scoreB: 0 }),
      binding,
    );
  }

  // Network goes offline; Map 2 (de_nuke) ends and series completes.
  online = false;
  nowMs += 10_000;
  output.beforeRuntimeMutation();
  const map2End = makeBundle({
    mapName: 'de_nuke',
    mapOrder: 2,
    mapPhase: 'gameover',
    seriesStatus: 'completed',
    scoreA: 2,
    scoreB: 0,
    scoreCT: 13,
    scoreT: 11,
    mapEpoch: 2,
    completedMap: { mapId: 'map-2', mapName: 'de_nuke', a: 13, b: 11 },
  });
  output.afterRuntimeMutation(
    makeReduceResult('2026-11-28T10:10:00.000Z', [
      { kind: 'map_ended', at: { utc: '2026-11-28T10:10:00.000Z' } } as never,
    ]),
    map2End,
    binding,
  );
  await output.retry();

  // Exit workbench completely (binding cleared) while still offline.
  output.setBinding(undefined);

  // Network recovers 5 seconds later; background retry flushes queued map_ended and series_ended.
  online = true;
  nowMs += 5_000;
  await output.retry();

  const nukeEnded = received.find(
    (r) => r.event.kind === 'map_ended' && r.event.mapName === 'de_nuke',
  );
  const seriesEnded = received.find((r) => r.event.kind === 'series_ended');
  assert.ok(nukeEnded);
  assert.equal(nukeEnded.authority, '7');
  assert.equal(nukeEnded.auth, 'Bearer secret-token');
  assert.equal(nukeEnded.event.kind, 'map_ended');
  if (nukeEnded.event.kind === 'map_ended') {
    assert.equal(nukeEnded.event.payload.scoreA, 13);
    assert.equal(nukeEnded.event.payload.scoreB, 11);
    assert.equal(nukeEnded.event.payload.lineupSteam64.length, 10);
    assert.equal(nukeEnded.event.payload.players?.length, 10);
    assert.equal(nukeEnded.event.payload.players?.[0]?.kills, 15);
  }
  assert.ok(seriesEnded);
  if (seriesEnded.event.kind === 'series_ended') {
    assert.deepEqual(seriesEnded.event.payload, { scoreA: 2, scoreB: 0 });
  }
});

test('HTTP 400 rejection marks one event rejected without blocking subsequent events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-nonblock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
  t.after(() => outbox.close());
  await outbox.load();

  const binding = makeBinding();
  const bundle = makeBundle({ mapName: 'de_nuke', mapOrder: 2, mapPhase: 'live' });
  const first = buildReliableEventV2({
    kind: 'map_started',
    bundle,
    binding,
    observedAt: '2026-11-28T10:00:00.000Z',
    authorityRevision: 2,
  })!;
  const second = buildReliableEventV2({
    kind: 'series_ended',
    bundle: makeBundle({ seriesStatus: 'completed', scoreA: 2, scoreB: 0 }),
    binding,
    observedAt: '2026-11-28T10:00:05.000Z',
    authorityRevision: 2,
  })!;

  assert.equal(outbox.enqueue(first, new Date('2026-11-28T10:00:00.000Z')), true);
  assert.equal(outbox.enqueue(second, new Date('2026-11-28T10:00:05.000Z')), true);

  const delivered: string[] = [];
  await outbox.flush(
    {
      send: async (event) => {
        if (event.idempotencyKey === first.idempotencyKey) {
          return { status: 'rejected', error: 'http_400' };
        }
        delivered.push(event.idempotencyKey);
        return { status: 'accepted' };
      },
    },
    new Date('2026-11-28T10:00:10.000Z'),
  );

  assert.deepEqual(delivered, [second.idempotencyKey]);
  const records = outbox.records();
  assert.equal(
    records.find((r) => r.event.idempotencyKey === first.idempotencyKey)?.status,
    'rejected',
  );
  assert.equal(
    records.find((r) => r.event.idempotencyKey === first.idempotencyKey)?.lastError,
    'http_400',
  );
  assert.equal(
    records.find((r) => r.event.idempotencyKey === second.idempotencyKey)?.status,
    'accepted',
  );
});

test('upgrading from a legacy SQLite database without outbox_events_v2 succeeds cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outboxPath = join(dir, 'reliable-outbox.json');
  const legacyDb = new DatabaseSync(`${outboxPath}.sqlite`);
  legacyDb.exec('CREATE TABLE outbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  legacyDb.close();

  const outbox = new ReliableOutbox(outboxPath);
  t.after(() => outbox.close());
  await outbox.load();
  assert.equal(outbox.isReady(), true);
  assert.deepEqual(outbox.records(), []);
});

test('idempotencyKey is deterministic and independent of contextRevision and runtimeSeq', () => {
  const b1 = makeBinding('rev-1');
  const b2 = makeBinding('rev-99');
  const bundle1 = makeBundle({ runtimeSeq: 10 });
  const bundle2 = makeBundle({ runtimeSeq: 999 });

  const e1 = buildReliableEventV2({
    kind: 'map_started',
    bundle: bundle1,
    binding: b1,
    observedAt: '2026-11-28T10:00:00.000Z',
    authorityRevision: 1,
  });
  const e2 = buildReliableEventV2({
    kind: 'map_started',
    bundle: bundle2,
    binding: b2,
    observedAt: '2026-11-28T10:01:00.000Z',
    authorityRevision: 3,
  });
  assert.ok(e1 && e2);
  assert.equal(e1.idempotencyKey, e2.idempotencyKey);
});

test('events older than 24h are marked expired without sending', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-expire-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
  t.after(() => outbox.close());
  await outbox.load();

  const event = buildReliableEventV2({
    kind: 'series_ended',
    bundle: makeBundle({ seriesStatus: 'completed', scoreA: 2, scoreB: 1 }),
    binding: makeBinding(),
    observedAt: '2026-11-28T10:00:00.000Z',
    authorityRevision: 1,
  })!;
  outbox.enqueue(event, new Date('2026-11-28T10:00:00.000Z'));

  let sendCalls = 0;
  await outbox.flush(
    {
      send: async () => {
        sendCalls++;
        return { status: 'accepted' };
      },
    },
    new Date('2026-11-29T10:00:01.000Z'),
  );
  assert.equal(sendCalls, 0);
  assert.equal(outbox.records()[0]?.status, 'expired');
});
