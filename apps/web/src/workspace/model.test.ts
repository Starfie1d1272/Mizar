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
    bindingState: 'bound',
    issues: [],
    score: { a: 1, b: 0 },
    requiredWins: 2,
    maps: [{ status: 'completed' }, { status: 'current' }],
  },
  matchContext: { freshness: 'fresh' },
  identity: { state: 'matched', issues: [] },
} as unknown as OperatorPayload;

it('reports observed health without treating CSTV availability as Program health', () => {
  expect(workspaceIssues(operator)).toEqual([]);
  expect(
    workspaceIssues({ ...operator, runtime: { ...operator.runtime, telemetryFreshness: 'stale' } }),
  ).toContainEqual(
    expect.objectContaining({ summary: '比赛数据已中断', path: '/settings?tab=gsi' }),
  );
});

it.each([
  ['map_mismatch', 'mismatch', '地图不一致', '/matches?tab=maps'],
  ['unexpected_human_steam64', 'mismatch', '选手 Steam64 不匹配', '/matches?tab=roster'],
  ['missing_canonical_steam64', 'degraded', '选手 Steam64 缺失', '/matches?tab=roster'],
  ['duplicate_canonical_steam64', 'degraded', '名单不一致', '/matches?tab=roster'],
  ['lineup_differs_from_expected', 'matched', '名单不一致', '/matches?tab=roster'],
  ['side_mapping_conflict', 'mismatch', '比赛身份待核对', '/matches?tab=roster'],
] as const)(
  'routes %s to its recovery task without exposing raw cause text',
  (code, state, summary, path) => {
    const payload = structuredClone(operator);
    payload.identity.state = state;
    payload.identity.issues = [
      {
        code,
        message: 'private raw cause',
        severity: 'warning',
      } as OperatorPayload['identity']['issues'][number],
    ];
    expect(workspaceIssues(payload)).toEqual([expect.objectContaining({ summary, path })]);
    expect(JSON.stringify(workspaceIssues(payload))).not.toContain('private raw cause');
  },
);

it('keeps awaiting input and incomplete evidence distinct from a confirmed mismatch', () => {
  const payload = structuredClone(operator);
  payload.runtime.telemetryFreshness = 'awaiting';
  payload.identity.state = 'resolving';
  payload.identity.issues = [
    { code: 'roster_evidence_pending' } as OperatorPayload['identity']['issues'][number],
  ];
  expect(workspaceIssues(payload)).toEqual([]);
  payload.seriesProgress = {
    ...payload.seriesProgress!,
    bindingState: 'needs_operator',
    issues: [],
  };
  expect(workspaceIssues(payload)).toEqual([
    expect.objectContaining({ summary: '地图执行待确认', path: '/matches?tab=maps' }),
  ]);
  payload.seriesProgress.issues = [
    { code: 'map_mismatch' } as NonNullable<OperatorPayload['seriesProgress']>['issues'][number],
  ];
  expect(workspaceIssues(payload)).toEqual([
    expect.objectContaining({ summary: '地图执行待确认' }),
  ]);
  payload.identity.issues = [
    { code: 'map_mismatch' } as OperatorPayload['identity']['issues'][number],
  ];
  payload.identity.state = 'mismatch';
  expect(workspaceIssues(payload)).toEqual([expect.objectContaining({ summary: '地图不一致' })]);
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
