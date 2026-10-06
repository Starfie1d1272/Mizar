import { expect, it } from 'vitest';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { workspaceCurrentPov, workspaceIssues, workspaceMatchScore } from './model';
import { getProgramFixture } from '../program/fixtures';

it('keeps map rounds separate from series wins through halftime, neutral input, and missing data', () => {
  const program = structuredClone(getProgramFixture('live-canonical')!.payload);
  program.teams.ct = {
    mode: 'canonical',
    entryId: program.series!.entrants.a.entryId,
    name: program.series!.entrants.a.name,
    logoUrl: null,
    seriesScore: 0,
  };
  program.teams.t = {
    mode: 'canonical',
    entryId: program.series!.entrants.b.entryId,
    name: program.series!.entrants.b.name,
    logoUrl: null,
    seriesScore: 0,
  };
  program.series!.score = { a: 0, b: 0 };
  program.map.score = { ct: 9, t: 3 };
  expect(workspaceMatchScore(program)).toMatchObject({
    teamA: { mapScore: 9 },
    teamB: { mapScore: 3 },
    seriesScoreText: '0:0',
  });
  [program.teams.ct, program.teams.t] = [program.teams.t, program.teams.ct];
  program.map.score = { ct: 3, t: 9 };
  expect(workspaceMatchScore(program)).toMatchObject({
    teamA: { mapScore: 9 },
    teamB: { mapScore: 3 },
  });
  program.series = null;
  expect(workspaceMatchScore(program)).toMatchObject({
    teamA: { name: 'CT', mapScore: 3 },
    teamB: { name: 'T', mapScore: 9 },
    seriesScoreText: null,
  });
  program.map.score = { ct: null, t: null };
  expect(workspaceMatchScore(program)!.teamA.mapScore).toBeNull();
  program.status.telemetry = 'stale';
  expect(workspaceMatchScore(program)).toBeNull();
});

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
