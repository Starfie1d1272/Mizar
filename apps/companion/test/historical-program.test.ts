import { expect, it } from 'vitest';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import { programPresentationSchema } from '@mizar/protocol/program-scenes';
import type { MatchContextBinding } from '../src/match-context/lkg-store.js';
import { projectHistoricalProgram } from '../src/projections/historical-program.js';
import legacy from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };
import extended from '../../../tests/fixtures/rivalhub-provider-stats-v1-extended.json' with { type: 'json' };
import single from '../../../tests/fixtures/rivalhub-provider-stats-v1-single-sided.json' with { type: 'json' };
import zero from '../../../tests/fixtures/rivalhub-provider-stats-v1-zero.json' with { type: 'json' };

function binding(raw: BroadcastStats): MatchContextBinding {
  const team = (entry: BroadcastStats['entrants'][number]) => ({
    entryId: entry.entryId,
    name: entry.name,
    logoUrl: entry.logoUrl,
    players: entry.starters.map((player) => ({
      playerId: player.userId,
      displayName: player.nickname,
      avatarUrl: player.avatarUrl,
      isStarter: true,
    })),
  });
  const manifestTeam = (entry: BroadcastStats['entrants'][number]) => ({
    entryId: entry.entryId,
    roster: {
      players: entry.starters.map((player) => ({ playerId: player.userId, isStarter: true })),
    },
  });
  return {
    origin: 'online',
    context: {
      matchId: raw.matchId,
      competition: { competitionId: raw.competitionId },
      mapPool: raw.mapPool ?? [],
      entrants: { a: team(raw.entrants[0]!), b: team(raw.entrants[1]!) },
    },
    manifest: {
      match: { matchId: raw.matchId },
      entrants: { a: manifestTeam(raw.entrants[0]!), b: manifestTeam(raw.entrants[1]!) },
    },
  } as unknown as MatchContextBinding;
}

it('preserves identity cards when historical data is missing and chooses one-sided topics', () => {
  const input = broadcastStatsSchema.parse(single);
  const output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  expect(output.pages.find((page) => page.kind === 'overview')?.teamIndices).toEqual([0]);
  expect(output.pages.find((page) => page.kind === 'recent')?.teamIndices).toEqual([0]);
  const missing = projectHistoricalProgram(binding(input), null, null, 'waiting');
  expect(missing.pages.map((page) => page.kind)).toEqual([
    'match',
    'lineup',
    'maps-info',
    'profile',
  ]);
  expect(missing.history).toEqual([null, null]);
  expect(missing.teams[0].starters).toHaveLength(5);
  const empty = broadcastStatsSchema.parse(zero);
  const emptyProjection = projectHistoricalProgram(binding(empty), empty, null, 'waiting');
  expect(emptyProjection.sourceRevision).toBe(empty.revision);
  expect(emptyProjection.pages.map((page) => page.kind)).toEqual([
    'match',
    'lineup',
    'maps-info',
    'profile',
  ]);
});

it('keeps the highest sampled Rating players through missing ADR and partial radar', () => {
  const input = broadcastStatsSchema.parse(extended);
  const top = input.entrants[1]!.playerPerformance.players[1]!;
  top.rating = 5;
  top.sample.ratingMaps = 1;
  top.adr = null;
  top.attributes.values[0]!.score = null;
  const output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  expect(output.selectedPlayerIds?.[1]).toBe(top.userId);
  expect(output.pages.find((page) => page.kind === 'players')?.playerIds[1]).toBe(top.userId);
  expect(output.pages.find((page) => page.kind === 'radar')?.playerIds[1]).toBe(top.userId);
  expect(output.radar?.mode).toBe('bars');
  expect(output.radar?.values[0]?.values[1]).toBeNull();
});

it('uses the local series, veto and last map summary without recomputing the website snapshot', () => {
  const input = broadcastStatsSchema.parse(extended);
  const summary = (order: number) => ({
    matchId: input.matchId,
    mapOrder: order,
    mapName: `de_map${order}`,
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: null,
      runtimeSeq: order,
      programSourceGeneration: 0,
      programReceiveSequence: null,
      mapEpoch: order,
    },
    score: { a: 13, b: 5 },
    players: { a: [], b: [] },
  });
  const program = programPresentationSchema.parse({
    schemaVersion: 'mizar.program-presentation.v2',
    packageId: 'builtin:mizar-default',
    match: { matchId: input.matchId, competition: null, format: 'bo3', stage: null },
    series: {
      format: 'bo3',
      requiredWins: 2,
      entrants: {
        a: { entryId: input.entrants[0]!.entryId, name: 'A', logoUrl: null },
        b: { entryId: input.entrants[1]!.entryId, name: 'B', logoUrl: null },
      },
      score: { a: 2, b: 0 },
      status: 'completed',
      bindingState: 'bound',
      currentMapOrder: null,
      maps: [
        {
          mapId: null,
          mapOrder: 1,
          mapName: 'de_map1',
          selection: { kind: 'decider' },
          teamAStartSide: null,
          status: 'completed',
          finalScore: { a: 13, b: 5 },
          winnerEntryId: input.entrants[0]!.entryId,
        },
      ],
      veto: [
        {
          stepOrder: 1,
          actionType: 'ban',
          mapName: 'de_nuke',
          entryId: input.entrants[0]!.entryId,
          side: null,
        },
      ],
      roundHistory: null,
    },
    halftime: summary(1),
    completed: [summary(1), summary(2)],
    eventLogoUrl: null,
    scheduledAt: null,
    previous: null,
    next: null,
  });
  const before = structuredClone(input);
  const output = projectHistoricalProgram(binding(input), input, program, 'intermap');
  expect(output.pages.slice(0, 3).map((page) => page.kind)).toEqual([
    'current-map',
    'series',
    'match',
  ]);
  expect(output.pages.find((page) => page.kind === 'bp')?.mapNames).toEqual(['de_nuke']);
  expect(output.program?.completed.at(-1)?.mapName).toBe('de_map2');
  expect(input).toEqual(before);
});

it('serves identity immediately while the website snapshot is absent, without fetching', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerHistoricalStatsProgramRoute } =
    await import('../src/match-context/rivalhub-routes.js');
  const input = broadcastStatsSchema.parse(single);
  const active = binding(input);
  let reads = 0;
  const app = Fastify();
  registerHistoricalStatsProgramRoute(app, {
    connection: {
      getStatsSnapshot: () => {
        reads++;
        return null;
      },
    } as unknown as import('../src/match-context/rivalhub-connection.js').RivalHubConnection,
    getBinding: () => active,
    getProgram: () => null,
    getScene: () => 'waiting',
  });
  try {
    const result = await app.inject('/local/v1/broadcast-stats-program');
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json().pages.map((page: { kind: string }) => page.kind)).toEqual([
      'match',
      'lineup',
      'maps-info',
      'profile',
    ]);
    expect(reads).toBe(1);
  } finally {
    await app.close();
  }
});

it('retains old v1 available topics when optional extended blocks are absent', () => {
  const input = broadcastStatsSchema.parse(legacy);
  const output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  expect(output.pages.some((page) => page.kind === 'maps')).toBe(true);
  expect(output.pages.some((page) => page.kind === 'utility')).toBe(true);
  expect(output.pages.some((page) => page.kind === 'flash')).toBe(true);
  expect(output.sourceRevision).toBe(input.revision);
});
