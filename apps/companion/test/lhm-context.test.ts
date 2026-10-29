import { readFileSync } from 'node:fs';
import { programPayloadSchema } from '@mizar/protocol/program';
import { expect, it } from 'vitest';
import { lhmContext } from '../src/hud-compat/context.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: { payload: unknown } }> };

it('maps canonical teams and series without fixing the sides across a switch', () => {
  const program = programPayloadSchema.parse(fixtures.fixtures['real-warmup']!.snapshot.payload);
  program.match = { matchId: 'match', competition: null, format: 'bo3', stage: null };
  program.teams = {
    ct: { mode: 'canonical', entryId: 'a', name: 'Alpha', logoUrl: null, seriesScore: 1 },
    t: { mode: 'canonical', entryId: 'b', name: 'Beta', logoUrl: null, seriesScore: 0 },
  };
  program.series = {
    format: 'bo3',
    requiredWins: 2,
    entrants: {
      a: { entryId: 'a', name: 'Alpha', logoUrl: null },
      b: { entryId: 'b', name: 'Beta', logoUrl: null },
    },
    score: { a: 1, b: 0 },
    status: 'live',
    bindingState: 'bound',
    currentMapOrder: 1,
    maps: [],
    veto: [{ stepOrder: 1, actionType: 'pick', mapName: 'de_ancient', entryId: 'a', side: null }],
    roundHistory: null,
  };
  const before = lhmContext(program)!;
  expect(new Set([before.match.left.id, before.match.right.id])).toEqual(new Set(['a', 'b']));
  expect(before.match.vetos[0]).toMatchObject({ type: 'pick', teamId: 'a', mapName: 'de_ancient' });
  program.teams = { ct: program.teams.t, t: program.teams.ct };
  const after = lhmContext(program)!;
  expect(after.match.left.id).toBe(before.match.right.id);
  expect(after.match.right.id).toBe(before.match.left.id);
  program.series.score.a = null;
  expect(lhmContext(program)).toBeNull();
});
