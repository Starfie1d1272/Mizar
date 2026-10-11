import { expect, it } from 'vitest';
import { resolveIdentity, type IdentityResolution } from '@mizar/core/identity';
import type { MatchContext } from '@mizar/core/match-context';
import type { ObservedPlayer } from '@mizar/core/telemetry';
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

function identityFixture(): { context: MatchContext; observed: ObservedPlayer[] } {
  const players = Array.from({ length: 10 }, (_, index) => ({
    playerId: `player-${index}`,
    steam64: String(76561198000000001n + BigInt(index)),
    displayName: `Player ${index}`,
    avatarUrl: null,
    isStarter: true,
  }));
  return {
    context: {
      matchId: 'match',
      competition: null,
      status: 'in_progress',
      format: 'bo1',
      stage: null,
      round: null,
      entryRound: null,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      scoreA: null,
      scoreB: null,
      isForfeit: false,
      entrants: {
        a: { entryId: 'a', name: 'A', logoUrl: null, rosterId: null, players: players.slice(0, 5) },
        b: { entryId: 'b', name: 'B', logoUrl: null, rosterId: null, players: players.slice(5) },
      },
      maps: [
        {
          mapId: 'map',
          mapOrder: 1,
          mapName: 'de_ancient',
          pickedByEntryId: null,
          teamAStartSide: null,
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
      ],
      veto: [],
      commentators: [],
    },
    observed: players.map((player, index) => ({
      sourcePlayerId: player.steam64,
      displayName: player.displayName,
      side: index < 5 ? 'CT' : 'T',
      observerSlot: index,
    })),
  };
}

function issuesFromResolution(identity: IdentityResolution) {
  return workspaceIssues({
    ...operator,
    identity: identity as unknown as OperatorPayload['identity'],
  });
}

it('prioritizes incomplete canonical data over unexpected accounts from the real resolver and clears after repair', () => {
  const { context, observed } = identityFixture();
  const resolve = (source: MatchContext, players = observed) =>
    resolveIdentity(source, {
      sourceGeneration: 0,
      mapEpoch: 1,
      allPlayers: players,
      allPlayersCoverage: 'present',
      mapName: 'de_ancient',
      mapPhase: 'live',
    });
  const missing: MatchContext = {
    ...context,
    entrants: {
      ...context.entrants,
      a: {
        ...context.entrants.a,
        players: context.entrants.a.players.map((p, i) => (i === 0 ? { ...p, steam64: null } : p)),
      },
    },
  };
  const missingResult = resolve(missing);
  expect(missingResult.state).toBe('degraded');
  expect(missingResult.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining(['missing_canonical_steam64', 'unexpected_human_steam64']),
  );
  expect(issuesFromResolution(missingResult)).toEqual([
    expect.objectContaining({ summary: '选手 Steam64 缺失', action: '补全名单' }),
  ]);
  const short: MatchContext = {
    ...missing,
    entrants: {
      ...missing.entrants,
      a: { ...missing.entrants.a, players: missing.entrants.a.players.slice(0, 4) },
    },
  };
  const shortResult = resolve(short);
  expect(shortResult.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining([
      'roster_incomplete',
      'missing_canonical_steam64',
      'unexpected_human_steam64',
    ]),
  );
  expect(issuesFromResolution(shortResult)).toEqual([
    expect.objectContaining({ summary: '名单不完整', action: '补全名单' }),
  ]);
  const duplicate: MatchContext = {
    ...context,
    entrants: {
      ...context.entrants,
      a: {
        ...context.entrants.a,
        players: context.entrants.a.players.map((p, i) =>
          i === 0 ? { ...p, steam64: context.entrants.a.players[1]!.steam64 } : p,
        ),
      },
    },
  };
  const duplicateResult = resolve(duplicate);
  expect(duplicateResult.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining(['duplicate_canonical_steam64', 'unexpected_human_steam64']),
  );
  expect(issuesFromResolution(duplicateResult)).toEqual([
    expect.objectContaining({ summary: '名单不一致' }),
  ]);
  const unexpectedResult = resolve(
    context,
    observed.map((p, i) => (i === 0 ? { ...p, sourcePlayerId: '76561198999999999' } : p)),
  );
  expect(issuesFromResolution(unexpectedResult)).toEqual([
    expect.objectContaining({ summary: '选手 Steam64 不匹配' }),
  ]);
  const repaired = resolve(context);
  expect(repaired.state).toBe('matched');
  expect(issuesFromResolution(repaired)).toEqual([]);
});

it('does not invent a roster conflict when a real map mismatch persists without current allplayers evidence', () => {
  const { context, observed } = identityFixture();
  const wrongMap = resolveIdentity(context, {
    sourceGeneration: 0,
    mapEpoch: 1,
    allPlayers: observed,
    allPlayersCoverage: 'present',
    mapName: 'de_overpass',
    mapPhase: 'live',
  });
  expect(wrongMap.state).toBe('mismatch');
  expect(issuesFromResolution(wrongMap)).toEqual([
    expect.objectContaining({ summary: '地图不一致' }),
  ]);
  const absent = resolveIdentity(
    context,
    {
      sourceGeneration: 0,
      mapEpoch: 1,
      allPlayersCoverage: 'absent',
    },
    wrongMap,
  );
  expect(absent.state).toBe('mismatch');
  expect(absent.issues.map((i) => i.code)).toEqual(['allplayers_unavailable']);
  expect(issuesFromResolution(absent)).toEqual([
    expect.objectContaining({
      summary: '比赛身份待核对',
      action: '核对比赛',
      path: '/matches',
    }),
  ]);
  expect(issuesFromResolution(absent)[0]!.detail).not.toMatch(/冲突|名单不一致|Steam64 不匹配/);
  const recovered = resolveIdentity(
    context,
    {
      sourceGeneration: 0,
      mapEpoch: 1,
      allPlayers: observed,
      allPlayersCoverage: 'present',
      mapName: 'de_ancient',
      mapPhase: 'live',
    },
    absent,
  );
  expect(recovered.state).toBe('matched');
  expect(issuesFromResolution(recovered)).toEqual([]);
});
