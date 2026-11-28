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

const MATCH_ID = '11111111-1111-4111-8111-111111111111';
const COMP_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_A_ID = '33333333-3333-4333-8333-333333333333';
const ENTRY_B_ID = '44444444-4444-4444-8444-444444444444';
const MAP_1_ID = '55555555-5555-4555-8555-555555555555';
const MAP_2_ID = '66666666-6666-4666-8666-666666666666';

function makeBinding(
  revision = 'rev-1',
  freshness: 'fresh' | 'stale' = 'fresh',
): MatchContextBinding {
  return {
    origin: 'online',
    freshness,
    manifest: { revision },
    context: {
      matchId: MATCH_ID,
      format: 'bo3',
      competition: { competitionId: COMP_ID, slug: 'cup', name: 'Cup', themeColor: null },
      entrants: {
        a: { entryId: ENTRY_A_ID, name: 'Team A', shortName: 'A', players: [] },
        b: { entryId: ENTRY_B_ID, name: 'Team B', shortName: 'B', players: [] },
      },
      maps: [
        { mapOrder: 1, mapId: MAP_1_ID, mapName: 'de_ancient' },
        { mapOrder: 2, mapId: MAP_2_ID, mapName: 'de_nuke' },
      ],
    },
  } as unknown as MatchContextBinding;
}

function makePlayers(prefix = '7656119800000000', killsBase = 15) {
  return Array.from({ length: 10 }, (_, index) => ({
    sourcePlayerId: `${prefix}${index}`,
    canonicalPlayerId: `player-${prefix.slice(-2)}-${index}`,
    identityEvidence: 'canonical' as const,
    lineupEvidence: 'current' as const,
    displayName: `Player ${index}`,
    side: index < 5 ? ('CT' as const) : ('T' as const),
    lifeState: 'alive' as const,
    state: null,
    weapons: [],
    matchStats: { kills: killsBase + index, assists: 3, deaths: 10 + index },
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
  scoreCT?: number | null;
  scoreT?: number | null;
  runtimeSeq?: number;
  mapEpoch?: number;
  telemetry?: 'fresh' | 'stale';
  context?: 'fresh' | 'stale';
  players?: ReturnType<typeof makePlayers>;
  completedMap?: { mapId: string; mapName: string; a: number; b: number };
}): ProjectionBundle {
  const mapOrder = overrides.mapOrder ?? 1;
  const mapName = overrides.mapName ?? 'de_ancient';
  const maps = [
    {
      mapOrder: 1,
      mapId: MAP_1_ID,
      mapName: 'de_ancient',
      status: mapOrder > 1 || overrides.completedMap?.mapId === MAP_1_ID ? 'completed' : 'live',
      finalScore:
        overrides.completedMap?.mapId === MAP_1_ID
          ? { a: overrides.completedMap.a, b: overrides.completedMap.b }
          : mapOrder > 1
            ? { a: 13, b: 8 }
            : null,
    },
    {
      mapOrder: 2,
      mapId: MAP_2_ID,
      mapName: 'de_nuke',
      status:
        overrides.completedMap?.mapId === MAP_2_ID
          ? 'completed'
          : mapOrder === 2
            ? 'live'
            : 'upcoming',
      finalScore:
        overrides.completedMap?.mapId === MAP_2_ID
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
      match: { matchId: MATCH_ID },
      status: {
        telemetry: overrides.telemetry ?? 'fresh',
        context: overrides.context ?? 'fresh',
        identity: 'matched',
      },
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
        score: {
          ct: overrides.scoreCT === undefined ? 13 : overrides.scoreCT,
          t: overrides.scoreT === undefined ? 8 : overrides.scoreT,
        },
      },
      round: { phase: 'live' },
      clock: null,
      teams: {
        ct: { entryId: ENTRY_A_ID, name: 'Team A', mode: 'canonical' },
        t: { entryId: ENTRY_B_ID, name: 'Team B', mode: 'canonical' },
      },
      players: overrides.players ?? makePlayers(),
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
      telemetryFreshness: overrides.telemetry ?? 'fresh',
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

test('map_ended across unrelated maps and offline workbench exit delivers map_ended with inline players on reconnect (no series_ended)', async (t) => {
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
      competitionId: COMP_ID,
      installationId: 'inst-1',
      matchId: MATCH_ID,
      producerInstanceId: 'prod-1',
      liveSessionId: 'sess-1',
      authorityRevision: 7,
    }),
  });
  t.after(() => output.close());
  await output.start();

  const binding = makeBinding();
  output.setCurrent(makeBundle({ mapName: 'de_ancient', mapOrder: 1, mapPhase: 'live' }), binding);
  output.beforeRuntimeMutation();
  output.afterRuntimeMutation(
    makeReduceResult('2026-11-28T10:01:00.000Z', [
      { kind: 'map_ended', at: { utc: '2026-11-28T10:01:00.000Z' } } as never,
    ]),
    makeBundle({
      mapName: 'de_ancient',
      mapOrder: 1,
      mapPhase: 'gameover',
      scoreA: 1,
      scoreB: 0,
      scoreCT: 13,
      scoreT: 8,
      completedMap: { mapId: MAP_1_ID, mapName: 'de_ancient', a: 13, b: 8 },
    }),
    binding,
  );
  await output.retry();
  assert.ok(received.some((r) => r.event.kind === 'map_ended' && r.event.mapName === 'de_ancient'));

  for (const fillerMap of ['de_dust2', 'de_mirage', 'de_inferno']) {
    output.beforeRuntimeMutation();
    output.afterRuntimeMutation(
      makeReduceResult('2026-11-28T10:05:00.000Z', []),
      makeBundle({ mapName: fillerMap, mapOrder: 2, mapPhase: 'warmup', scoreA: 1, scoreB: 0 }),
      binding,
    );
  }

  online = false;
  nowMs += 10_000;
  output.beforeRuntimeMutation();
  output.afterRuntimeMutation(
    makeReduceResult('2026-11-28T10:10:00.000Z', [
      { kind: 'map_ended', at: { utc: '2026-11-28T10:10:00.000Z' } } as never,
    ]),
    makeBundle({
      mapName: 'de_nuke',
      mapOrder: 2,
      mapPhase: 'gameover',
      seriesStatus: 'completed',
      scoreA: 2,
      scoreB: 0,
      scoreCT: 13,
      scoreT: 11,
      mapEpoch: 2,
      completedMap: { mapId: MAP_2_ID, mapName: 'de_nuke', a: 13, b: 11 },
    }),
    binding,
  );
  await output.retry();

  output.setBinding(undefined);

  online = true;
  nowMs += 5_000;
  await output.retry();

  const nukeEnded = received.find(
    (r) => r.event.kind === 'map_ended' && r.event.mapName === 'de_nuke',
  );
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
  assert.equal(
    received.some((r) => (r.event.kind as string) === 'series_ended'),
    false,
  );
});

test('stale binding at map end still enqueues map_ended with original map roster without next-map overwrite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
  const output = new OutputService({ outbox, now: () => new Date('2026-11-28T10:00:00.000Z') });
  t.after(() => output.close());
  await output.start();

  const freshBinding = makeBinding('rev-1', 'fresh');
  const map1Players = makePlayers('7656119811111111', 22);
  output.setCurrent(
    makeBundle({ mapName: 'de_ancient', mapOrder: 1, mapPhase: 'live', players: map1Players }),
    freshBinding,
  );

  // Moment of map completion: binding is transiently stale, and map immediately switches to de_nuke with different players.
  const staleBinding = makeBinding('rev-1', 'stale');
  const map2Players = makePlayers('7656119822222222', 3);
  output.beforeRuntimeMutation();
  output.afterRuntimeMutation(
    makeReduceResult('2026-11-28T10:02:00.000Z', []),
    makeBundle({
      mapName: 'de_nuke',
      mapOrder: 2,
      mapPhase: 'warmup',
      scoreA: 1,
      scoreB: 0,
      scoreCT: 0,
      scoreT: 0,
      telemetry: 'stale',
      context: 'stale',
      players: map2Players,
      completedMap: { mapId: MAP_1_ID, mapName: 'de_ancient', a: 13, b: 8 },
    }),
    staleBinding,
  );

  const mapEndedRecords = outbox.records().filter((r) => r.event.kind === 'map_ended');
  assert.equal(mapEndedRecords.length, 1);
  const ev = mapEndedRecords[0]!.event;
  assert.equal(ev.mapName, 'de_ancient');
  if (ev.kind === 'map_ended') {
    assert.equal(ev.payload.scoreA, 13);
    assert.equal(ev.payload.scoreB, 8);
    assert.equal(ev.payload.scoreCT, 13);
    assert.equal(ev.payload.scoreT, 8);
    assert.equal(ev.payload.lineupSteam64[0], '76561198111111110');
    assert.equal(ev.payload.players?.[0]?.kills, 22);
  }
});

test('legacy SQLite metadata.active migrates pending map_ended once and ignores legacy boundary events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outboxPath = join(dir, 'reliable-outbox.json');
  const db = new DatabaseSync(`${outboxPath}.sqlite`);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const legacyActive = {
    version: 'mizar.reliable-outbox.v3',
    records: [
      {
        status: 'pending',
        event: {
          schemaVersion: 'mizar.reliable-event.v1',
          idempotencyKey: 'legacy-boundary-1',
          kind: 'map_epoch_changed',
          observedAt: '2026-11-28T09:00:00.000Z',
          matchId: MATCH_ID,
          competitionId: COMP_ID,
          entryAId: ENTRY_A_ID,
          entryBId: ENTRY_B_ID,
          mapId: MAP_1_ID,
          mapName: 'de_ancient',
          cursor: { producerInstanceId: 'prod-1', liveSessionId: 'sess-1' },
          payload: { previousMapEpoch: 0, reason: null },
        },
      },
      {
        status: 'pending',
        lineupSteam64: Array.from({ length: 10 }, (_, i) => `7656119800000000${i}`),
        source: { authorityRevision: 4 },
        event: {
          schemaVersion: 'mizar.reliable-event.v1',
          idempotencyKey: 'legacy-map-end-1',
          kind: 'map_ended',
          observedAt: '2026-11-28T09:30:00.000Z',
          matchId: MATCH_ID,
          competitionId: COMP_ID,
          entryAId: ENTRY_A_ID,
          entryBId: ENTRY_B_ID,
          mapId: MAP_1_ID,
          mapName: 'de_ancient',
          cursor: { producerInstanceId: 'prod-1', liveSessionId: 'sess-1' },
          payload: { scoreA: 13, scoreB: 9, scoreCT: 13, scoreT: 9 },
        },
      },
      {
        status: 'pending',
        event: {
          schemaVersion: 'mizar.reliable-event.v1',
          idempotencyKey: 'legacy-snap-1',
          kind: 'map_player_snapshot',
          observedAt: '2026-11-28T09:30:01.000Z',
          matchId: MATCH_ID,
          competitionId: COMP_ID,
          entryAId: ENTRY_A_ID,
          entryBId: ENTRY_B_ID,
          mapId: MAP_1_ID,
          mapName: 'de_ancient',
          cursor: { producerInstanceId: 'prod-1', liveSessionId: 'sess-1' },
          payload: {
            mapEndedKey: 'legacy-map-end-1',
            players: [
              {
                sourcePlayerId: '76561198000000000',
                canonicalPlayerId: null,
                kills: 20,
                assists: 5,
                deaths: 12,
              },
            ],
          },
        },
      },
    ],
  };
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
    'active',
    JSON.stringify(legacyActive),
  );
  db.close();

  const outbox = new ReliableOutbox(outboxPath);
  t.after(() => outbox.close());
  await outbox.load();
  const records = outbox.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.event.idempotencyKey, 'legacy-map-end-1');
  assert.equal(records[0]!.event.kind, 'map_ended');
  assert.equal(records[0]!.event.session.authorityRevision, 4);
  if (records[0]!.event.kind === 'map_ended') {
    assert.equal(records[0]!.event.payload.lineupSteam64.length, 10);
    assert.equal(records[0]!.event.payload.players?.[0]?.kills, 20);
  }
});

test('HTTP 400 rejection marks one event rejected without blocking subsequent events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-nonblock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
  t.after(() => outbox.close());
  await outbox.load();

  const binding = makeBinding();
  const first = buildReliableEventV2({
    kind: 'map_started',
    bundle: makeBundle({ mapName: 'de_nuke', mapOrder: 2, mapPhase: 'live' }),
    binding,
    observedAt: '2026-11-28T10:00:00.000Z',
    authorityRevision: 2,
  })!;
  const second = buildReliableEventV2({
    kind: 'map_ended',
    bundle: makeBundle({
      mapName: 'de_nuke',
      mapOrder: 2,
      mapPhase: 'gameover',
      scoreCT: 13,
      scoreT: 7,
    }),
    binding,
    observedAt: '2026-11-28T10:30:00.000Z',
    authorityRevision: 2,
    completedMap: { mapId: MAP_2_ID, mapName: 'de_nuke', scoreA: 13, scoreB: 7 },
  })!;

  assert.equal(outbox.enqueue(first, new Date('2026-11-28T10:00:00.000Z')), true);
  assert.equal(outbox.enqueue(second, new Date('2026-11-28T10:30:00.000Z')), true);

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
    new Date('2026-11-28T10:31:00.000Z'),
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

test('map_started expires after 24h while map_ended is retained up to 7 days', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-v2-expire-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outbox = new ReliableOutbox(join(dir, 'outbox.json'));
  t.after(() => outbox.close());
  await outbox.load();

  const startEvent = buildReliableEventV2({
    kind: 'map_started',
    bundle: makeBundle({ mapName: 'de_ancient', mapOrder: 1, mapPhase: 'live' }),
    binding: makeBinding(),
    observedAt: '2026-11-28T10:00:00.000Z',
    authorityRevision: 1,
  })!;
  const endEvent = buildReliableEventV2({
    kind: 'map_ended',
    bundle: makeBundle({ mapName: 'de_ancient', mapOrder: 1, mapPhase: 'gameover' }),
    binding: makeBinding(),
    observedAt: '2026-11-28T10:30:00.000Z',
    authorityRevision: 1,
    completedMap: { mapId: MAP_1_ID, mapName: 'de_ancient', scoreA: 13, scoreB: 8 },
  })!;
  outbox.enqueue(startEvent, new Date('2026-11-28T10:00:00.000Z'));
  outbox.enqueue(endEvent, new Date('2026-11-28T10:30:00.000Z'));

  const sent: string[] = [];
  await outbox.flush(
    {
      send: async (event) => {
        sent.push(event.kind);
        return { status: 'accepted' };
      },
    },
    new Date('2026-11-29T11:00:00.000Z'),
  );
  assert.deepEqual(sent, ['map_ended']);
  assert.equal(
    outbox.records().find((r) => r.event.idempotencyKey === startEvent.idempotencyKey)?.status,
    'expired',
  );
  assert.equal(
    outbox.records().find((r) => r.event.idempotencyKey === endEvent.idempotencyKey)?.status,
    'accepted',
  );
});
