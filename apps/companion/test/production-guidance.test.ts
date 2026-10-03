import { expect, it } from 'vitest';
import { ProductionGuidanceStore } from '../src/program-scenes/guidance.js';
import type { ProjectionBundle } from '../src/projections/projection-coordinator.js';
import type { MatchContextBinding } from '../src/match-context/index.js';

function bundle(): ProjectionBundle {
  return {
    program: {
      match: { matchId: 'match-1' },
      cursor: {
        producerInstanceId: 'producer',
        liveSessionId: 'session',
        runtimeSeq: 10,
        mapEpoch: 1,
        programSourceGeneration: 1,
      },
      status: { context: 'fresh', identity: 'matched', telemetry: 'fresh' },
      map: { phase: 'gameover' },
      series: {
        status: 'live',
        bindingState: 'bound',
        currentMapOrder: 1,
        score: { a: 1, b: 0 },
        maps: [
          {
            mapId: 'map-1',
            mapOrder: 1,
            mapName: 'de_mirage',
            status: 'completed',
            finalScore: { a: 13, b: 9 },
          },
          { mapId: 'map-2', mapOrder: 2, mapName: 'de_nuke', status: 'pending', finalScore: null },
        ],
      },
    },
    operator: {
      seriesProgress: {
        maps: [{ mapOrder: 1, mapName: 'de_mirage', status: 'completed', executionMapEpoch: 1 }],
      },
      runtime: {
        recentTransitions: [
          {
            kind: 'map_ended',
            runtimeSeq: 10,
            liveSession: { kind: 'bound', liveSessionId: 'session' },
            mapEpoch: 1,
            sourceGeneration: 1,
            producerInstanceId: 'producer',
            at: { monotonicMs: 0 },
          },
        ],
      },
    },
  } as unknown as ProjectionBundle;
}
function binding(): MatchContextBinding {
  return {
    origin: 'online',
    context: { matchId: 'match-1', commentators: [{ liveStreamUrl: null }], maps: [] },
    manifest: { match: { competition: { slug: 'rivals' } } },
  } as unknown as MatchContextBinding;
}
it('shows map-end despite fresh telemetry and reminds after ten minutes across repeated reads', () => {
  let now = 0;
  const store = new ProductionGuidanceStore(() => now);
  const b = bundle();
  expect(store.get(b, binding())).toMatchObject({
    phase: 'map_end',
    nextMap: 'de_nuke',
    interMapReminder: false,
    broadcastAssigned: true,
    rivalhubUrl: 'https://match.starfie1d.top/admin/rivals/matches/match-1',
  });
  now = 600_000;
  expect(store.get(b, binding()).interMapReminder).toBe(true);
  const next = structuredClone(b);
  Object.assign(next.program.series!.maps[1]!, { status: 'current' });
  Object.assign(next.program.map, { phase: 'live' });
  expect(store.get(next).phase).toBe('live');
  expect(store.get(next).interMapReminder).toBe(false);
  Object.assign(next.program.series!, { status: 'completed' });
  expect(store.get(next)).toMatchObject({
    phase: 'match_end',
    nextMap: null,
    interMapReminder: false,
  });
});
it('does not invent elapsed time without evidence or reuse it for another match', () => {
  const store = new ProductionGuidanceStore(() => 900_000);
  const b = bundle();
  store.get(b);
  const other = structuredClone(b);
  Object.assign(other.program.match!, { matchId: 'other' });
  Object.assign(other.operator.runtime, { recentTransitions: [] });
  expect(store.get(other).interMapReminder).toBe(false);
  expect(store.get(other).broadcastAssigned).toBe(false);
});
it('can restore a reminder using an existing completedAt', () => {
  const b = bundle();
  Object.assign(b.operator.runtime, { recentTransitions: [] });
  const context = binding();
  Object.assign(context.context, {
    maps: [
      { mapId: 'map-1', mapName: 'de_mirage', mapOrder: 1, completedAt: '2026-10-03T00:00:00Z' },
    ],
  });
  const store = new ProductionGuidanceStore(
    () => 50,
    () => Date.parse('2026-10-03T00:11:00Z'),
  );
  expect(store.get(b, context).interMapReminder).toBe(true);
});

it('keeps halftime on the current map and rejects old-generation clock evidence', () => {
  const b = bundle();
  Object.assign(b.program.series!.maps[1]!, { status: 'current' });
  Object.assign(b.program.map, { phase: 'intermission' });
  const store = new ProductionGuidanceStore(() => 900_000);
  expect(store.get(b).phase).toBe('live');
  const old = bundle();
  Object.assign(old.program.cursor, { programSourceGeneration: 2 });
  expect(new ProductionGuidanceStore(() => 900_000).get(old).interMapReminder).toBe(false);
});

const startUtc = Date.parse('2026-10-03T00:00:00Z');
function clock() {
  let elapsed = 0;
  return {
    store: new ProductionGuidanceStore(
      () => elapsed,
      () => startUtc + elapsed,
    ),
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}
function timestamp(b: ProjectionBundle, at: number | null) {
  const context = binding();
  const map = [...b.program.series!.maps].reverse().find((m) => m.status === 'completed')!;
  Object.assign(context.context, {
    matchId: b.program.match!.matchId,
    maps: [
      {
        mapId: map.mapId,
        mapName: map.mapName,
        mapOrder: map.mapOrder,
        completedAt: at === null ? null : new Date(startUtc + at).toISOString(),
      },
    ],
  });
  return context;
}
function secondMap(first: ProjectionBundle) {
  const b = structuredClone(first);
  Object.assign(b.program.cursor, { runtimeSeq: 20, mapEpoch: 2 });
  Object.assign(b.program.series!, { currentMapOrder: 2, score: { a: 1, b: 1 } });
  Object.assign(b.program.series!.maps[1]!, {
    mapName: 'de_mirage',
    status: 'completed',
    finalScore: { a: 10, b: 13 },
  });
  Object.assign(b.program.series!, {
    maps: [
      ...b.program.series!.maps,
      {
        ...b.program.series!.maps[0],
        mapId: 'map-3',
        mapOrder: 3,
        mapName: 'de_ancient',
        status: 'pending',
        finalScore: null,
      },
    ],
  });
  Object.assign(b.operator.seriesProgress!, {
    maps: [{ mapOrder: 2, mapName: 'de_mirage', status: 'completed', executionMapEpoch: 2 }],
  });
  Object.assign(b.operator.runtime, { recentTransitions: [] });
  return b;
}

it('invalidates map 1 before reading map 2 without a time, then starts only from supplied evidence', () => {
  const { store, advance } = clock();
  const first = bundle();
  store.get(first, timestamp(first, 0));
  advance(3_600_000);
  expect(store.get(first).interMapReminder).toBe(true);
  const second = secondMap(first);
  for (let i = 0; i < 3; i++) {
    expect(store.get(second, timestamp(second, null))).toMatchObject({
      result: 'de_mirage · 10 : 13',
      nextMap: 'de_ancient',
      interMapReminder: false,
    });
  }
  expect(new ProductionGuidanceStore(() => 3_600_000).get(second).interMapReminder).toBe(false);
  const trusted = timestamp(second, 3_600_000);
  expect(store.get(second, trusted).interMapReminder).toBe(false);
  advance(599_999);
  expect(store.get(second, trusted).interMapReminder).toBe(false);
  advance(1);
  expect(store.get(second, trusted).interMapReminder).toBe(true);
});

it('can receive a new trusted map-ended after the completed context arrived first', () => {
  const { store, advance } = clock();
  const first = bundle();
  store.get(first);
  advance(3_600_000);
  const second = secondMap(first);
  expect(store.get(second).interMapReminder).toBe(false);
  Object.assign(second.program.cursor, { runtimeSeq: 21 });
  Object.assign(second.operator.runtime, {
    recentTransitions: [
      {
        ...first.operator.runtime.recentTransitions[0],
        mapEpoch: 2,
        runtimeSeq: 21,
        at: { monotonicMs: 3_600_000 },
      },
    ],
  });
  expect(store.get(second).interMapReminder).toBe(false);
  advance(600_000);
  expect(store.get(second).interMapReminder).toBe(true);
});

for (const invalid of ['epoch', 'generation', 'producer', 'session', 'already-observed'] as const) {
  it(`rejects ${invalid} late events after changing completed maps`, () => {
    const { store, advance } = clock();
    const first = bundle();
    store.get(first);
    advance(3_600_000);
    const second = secondMap(first);
    const event = { ...first.operator.runtime.recentTransitions[0], runtimeSeq: 21, mapEpoch: 2 };
    if (invalid === 'epoch') event.mapEpoch = 1;
    if (invalid === 'generation') Object.assign(event, { sourceGeneration: 0 });
    if (invalid === 'producer') Object.assign(event, { producerInstanceId: 'old' });
    if (invalid === 'session')
      Object.assign(event, { liveSession: { kind: 'bound', liveSessionId: 'old' } });
    if (invalid === 'already-observed') event.runtimeSeq = 10;
    Object.assign(second.program.cursor, { runtimeSeq: 21 });
    Object.assign(second.operator.runtime, { recentTransitions: [event] });
    expect(store.get(second).interMapReminder).toBe(false);
  });
}

for (const changed of [
  'generation',
  'epoch',
  'map-id',
  'map-name',
  'match',
  'session',
  'producer',
] as const) {
  it(`clears an existing anchor on ${changed} change without a replacement time`, () => {
    const { store, advance } = clock();
    const b = bundle();
    store.get(b);
    advance(900_000);
    expect(store.get(b).interMapReminder).toBe(true);
    if (changed === 'generation') Object.assign(b.program.cursor, { programSourceGeneration: 2 });
    if (changed === 'epoch') {
      Object.assign(b.program.cursor, { mapEpoch: 2 });
      Object.assign(b.operator.seriesProgress!.maps[0]!, { executionMapEpoch: 2 });
    }
    if (changed === 'map-id') Object.assign(b.program.series!.maps[0]!, { mapId: 'replacement' });
    if (changed === 'map-name') Object.assign(b.program.series!.maps[0]!, { mapName: 'de_dust2' });
    if (changed === 'match') Object.assign(b.program.match!, { matchId: 'other' });
    if (changed === 'session') Object.assign(b.program.cursor, { liveSessionId: 'other' });
    if (changed === 'producer') Object.assign(b.program.cursor, { producerInstanceId: 'other' });
    expect(store.get(b).interMapReminder).toBe(false);
  });
}

it('keeps same-generation reconnects stable but restores a new generation only from a matching timestamp', () => {
  const { store, advance } = clock();
  const b = bundle();
  store.get(b);
  advance(600_000);
  Object.assign(b.operator.runtime, { recentTransitions: [] });
  Object.assign(b.program.status, { telemetry: 'stale' });
  expect(store.get(b).interMapReminder).toBe(true);
  Object.assign(b.program.status, { telemetry: 'fresh' });
  expect(store.get(b).interMapReminder).toBe(true);
  Object.assign(b.program.cursor, { programSourceGeneration: 2 });
  expect(store.get(b).interMapReminder).toBe(false);
  expect(store.get(b, timestamp(b, 0)).interMapReminder).toBe(true);
});

it('requires a matching authoritative timestamp and does not manufacture time from context arrival', () => {
  for (const wrong of ['match', 'map-id', 'map-name', 'order', 'future', 'invalid'] as const) {
    const { store, advance } = clock();
    const first = bundle();
    store.get(first);
    advance(3_600_000);
    const b = secondMap(first);
    const context = timestamp(b, 0);
    const map = context.context.maps[0]!;
    if (wrong === 'match') Object.assign(context.context, { matchId: 'other' });
    if (wrong === 'map-id') Object.assign(map, { mapId: 'other' });
    if (wrong === 'map-name') Object.assign(map, { mapName: 'other' });
    if (wrong === 'order') Object.assign(map, { mapOrder: 1 });
    if (wrong === 'future')
      Object.assign(map, { completedAt: new Date(startUtc + 9_000_000).toISOString() });
    if (wrong === 'invalid') Object.assign(map, { completedAt: 'unknown' });
    expect(store.get(b, context).interMapReminder, wrong).toBe(false);
  }
});

it('suppresses existing reminders during live play, halftime, series end and without a following map', () => {
  for (const phase of ['live', 'intermission', 'series-end', 'no-next'] as const) {
    const { store, advance } = clock();
    const b = bundle();
    store.get(b);
    advance(600_000);
    expect(store.get(b).interMapReminder).toBe(true);
    if (phase === 'live' || phase === 'intermission') {
      Object.assign(b.program.series!.maps[1]!, { status: 'current' });
      Object.assign(b.program.map, { phase });
    }
    if (phase === 'series-end') Object.assign(b.program.series!, { status: 'completed' });
    if (phase === 'no-next')
      Object.assign(b.program.series!, { maps: [b.program.series!.maps[0]] });
    expect(store.get(b).interMapReminder, phase).toBe(false);
  }
});
