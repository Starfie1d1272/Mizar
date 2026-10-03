import { expect, it } from 'vitest';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { workspaceCurrentPov, workspaceIssues } from './model';

const operator = {
  runtime: { telemetryFreshness: 'fresh', mapName: 'de_ancient' },
  seriesProgress: {
    score: { a: 1, b: 0 },
    requiredWins: 2,
    maps: [{ status: 'completed' }, { status: 'current' }],
  },
  matchContext: { freshness: 'fresh' },
  identity: { state: 'matched' },
} as OperatorPayload;

it('reports observed health without treating CSTV availability as Program health', () => {
  expect(workspaceIssues(operator)).toEqual([]);
  expect(
    workspaceIssues({ ...operator, runtime: { ...operator.runtime, telemetryFreshness: 'stale' } }),
  ).toContain('比赛数据已中断，请检查 CS2 与 GSI。');
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
