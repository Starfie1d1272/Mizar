import { expect, it } from 'vitest';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { BpSnapshot } from '@mizar/protocol/bp';
import type { ProgramPayload } from '@mizar/protocol/program';
import { workspaceCurrentPov, workspaceIssues, workspacePhase } from './model';

const operator = {
  runtime: { telemetryFreshness: 'fresh', mapName: 'de_ancient' },
  seriesProgress: { score: { a: 1, b: 0 }, requiredWins: 2, maps: [{ status: 'completed' }] },
  matchContext: { freshness: 'fresh' },
  identity: { state: 'matched' },
} as OperatorPayload;

it('gives active BP priority over live telemetry and avoids CSTV health as Program truth', () => {
  const bp = { state: 'shown', projection: {} } as BpSnapshot;
  expect(workspacePhase(operator, bp)).toBe('bp');
  expect(workspacePhase(operator, null)).toBe('live');
  expect(
    workspaceIssues({
      ...operator,
      sources: { cstvProgram: { state: 'disabled' }, cstvLookahead: { state: 'disabled' } },
    } as OperatorPayload),
  ).toEqual([]);
});

it('uses existing series progress for map and match end', () => {
  const ended = {
    ...operator,
    runtime: { telemetryFreshness: 'stale', mapName: null },
  } as OperatorPayload;
  expect(workspacePhase(ended, null)).toBe('map_end');
  expect(
    workspacePhase(
      { ...ended, seriesProgress: { ...ended.seriesProgress!, score: { a: 2, b: 0 } } },
      null,
    ),
  ).toBe('match_end');
});

it('shows the current POV only from fresh, identity-safe current-lineup Program evidence', () => {
  const program = {
    status: { telemetry: 'fresh', identity: 'matched' },
    observedPlayerSourceId: 'player-1',
    players: [
      { sourcePlayerId: 'player-1', lineupEvidence: 'current', displayName: 'Observer Target' },
    ],
  } as unknown as ProgramPayload;
  expect(workspaceCurrentPov(program)).toBe('Observer Target');
  expect(
    workspaceCurrentPov({
      ...program,
      status: { ...program.status, telemetry: 'stale' },
    }),
  ).toBeNull();
  expect(
    workspaceCurrentPov({
      ...program,
      status: { ...program.status, identity: 'mismatch' },
    }),
  ).toBeNull();
});
