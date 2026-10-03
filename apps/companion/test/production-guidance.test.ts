import { expect, it } from 'vitest';
import { ProductionGuidanceStore } from '../src/program-scenes/guidance.js';
import type { ProjectionBundle } from '../src/projections/projection-coordinator.js';
import type { MatchContextBinding } from '../src/match-context/index.js';

function bundle(): ProjectionBundle {
  return {
    program: {
      match: { matchId: 'match-1' },
      cursor: { producerInstanceId: 'producer', mapEpoch: 1, programSourceGeneration: 1 },
      status: { context: 'fresh', identity: 'matched', telemetry: 'fresh' },
      map: { phase: 'gameover' },
      series: {
        status: 'live',
        bindingState: 'bound',
        currentMapOrder: 1,
        score: { a: 1, b: 0 },
        maps: [
          { mapOrder: 1, mapName: 'de_mirage', status: 'completed', finalScore: { a: 13, b: 9 } },
          { mapOrder: 2, mapName: 'de_nuke', status: 'pending', finalScore: null },
        ],
      },
    },
    operator: {
      runtime: {
        recentTransitions: [
          {
            kind: 'map_ended',
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
    context: { commentators: [{ liveStreamUrl: null }], maps: [] },
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
  Object.assign(context.context, { maps: [{ mapOrder: 1, completedAt: '2026-10-03T00:00:00Z' }] });
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
