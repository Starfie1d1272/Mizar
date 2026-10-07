import { LOCAL_PROTOCOL_VERSION, PROGRAM_SCHEMA_VERSION } from '@mizar/protocol';
import {
  programSnapshotSchema,
  type ProgramPayload,
  type ProgramSnapshot,
} from '@mizar/protocol/program';

import { realProgramFixtures, type RealProgramFixtureId } from './real-program-fixtures.js';
import {
  derivePresentationStressFixture,
  type PresentationStressPatch,
} from './presentation-stress.js';
import { RIVALS_BP_RECORDS, rivalsSeriesCut } from './rivals-bp-records.js';

type ProgramPlayer = ProgramPayload['players'][number];
type PlayerState = NonNullable<ProgramPlayer['state']>;
type MatchStats = NonNullable<ProgramPlayer['matchStats']>;
type ProgramWeapon = ProgramPlayer['weapons'][number];
type ProgramTeam = ProgramPayload['teams']['ct'];
type ProgramMatch = NonNullable<ProgramPayload['match']>;
type LiveStatus = ProgramPayload['status'];
type ProgramSeries = NonNullable<ProgramPayload['series']>;

const FIXTURE_CURSOR = {
  producerInstanceId: 'fixture-producer',
  liveSessionId: 'fixture-session',
  runtimeSeq: 42,
  programSourceGeneration: 1,
  programReceiveSequence: 42,
  mapEpoch: 1,
} as const;

const LIVE_COVERAGE = {
  map: 'present',
  round: 'present',
  phaseCountdowns: 'present',
  player: 'present',
  allPlayers: 'present',
  bomb: 'absent',
} satisfies ProgramPayload['coverage'];

const BOMB_COVERAGE: ProgramPayload['coverage'] = { ...LIVE_COVERAGE, bomb: 'present' };

const DEFAULT_PLAYER_STATE: PlayerState = {
  health: 100,
  armor: 100,
  hasHelmet: true,
  hasDefuser: false,
  flashed: 0,
  smoked: 0,
  burning: 0,
  money: 4_200,
  roundTotalDamage: 0,
  roundKills: 0,
  roundKillHeadshots: 0,
  equipValue: 3_900,
};

const DEFAULT_MATCH_STATS: MatchStats = {
  kills: 12,
  assists: 3,
  deaths: 8,
  mvps: 2,
  score: 15,
};

function neutralTeam(name: 'CT' | 'T'): ProgramTeam {
  return {
    mode: 'neutral',
    entryId: null,
    name,
    logoUrl: null,
    seriesScore: null,
  };
}

function canonicalTeam(
  entryId: string,
  name: string,
  seriesScore: number | null,
  logoUrl: string | null = null,
): ProgramTeam {
  return {
    mode: 'canonical',
    entryId,
    name,
    logoUrl,
    seriesScore,
  };
}

function makeWeapon(
  sourceWeaponId: string,
  name: string,
  state: NonNullable<ProgramWeapon['state']>,
): ProgramWeapon {
  return {
    sourceWeaponId,
    name,
    paintKit: null,
    type: 'rifle',
    ammoClip: 30,
    ammoClipMax: 30,
    ammoReserve: 90,
    state,
  };
}

function makeUtilityWeapon(
  sourceWeaponId: string,
  name: string,
  ammoReserve: number | null,
): ProgramWeapon {
  return {
    sourceWeaponId,
    name,
    paintKit: null,
    type: 'grenade',
    ammoClip: null,
    ammoClipMax: null,
    ammoReserve,
    state: 'holstered',
  };
}

function makePlayer(
  sourcePlayerId: string,
  side: 'CT' | 'T',
  observerSlot: number,
  overrides: Partial<ProgramPlayer> = {},
): ProgramPlayer {
  return {
    sourcePlayerId,
    canonicalPlayerId: null,
    identityEvidence: 'observed',
    lineupEvidence: 'current',
    displayName: sourcePlayerId,
    displayNameSource: 'observed',
    avatarUrl: null,
    side,
    observerSlot,
    activity: 'playing',
    lifeState: 'alive',
    liveAdr: null,
    completedAdr: null,
    weaponsAvailable: true,
    currentRoundDamage: null,
    roundMoneySpent: 0,
    state: { ...DEFAULT_PLAYER_STATE },
    matchStats: { ...DEFAULT_MATCH_STATS },
    weapons: [],
    ...overrides,
  };
}

function observedPlayers(): ProgramPlayer[] {
  return Array.from({ length: 10 }, (_, index) => {
    const side = index < 5 ? 'CT' : 'T';
    const slot = index + 1;
    return makePlayer(`fixture-player-${side.toLowerCase()}-${slot}`, side, slot, {
      displayName: `Observed ${side} ${String(slot).padStart(2, '0')}`,
    });
  });
}

function canonicalPlayers(): ProgramPlayer[] {
  const names = ['Astra', 'Boreal', 'Cinder', 'Drift', 'Ember'];
  return observedPlayers().map((player, index) => {
    const side = index < 5 ? 'ct' : 't';
    const playerSide = index < 5 ? 'CT' : 'T';
    const name = names[index % names.length] ?? 'Player';
    return makePlayer(player.sourcePlayerId, playerSide, index + 1, {
      canonicalPlayerId: `fixture-canonical-${side}-${index % 5}`,
      identityEvidence: 'canonical',
      displayName: `${name} ${player.side}`,
      displayNameSource: 'canonical',
      state: player.state,
      matchStats: player.matchStats,
      weapons: player.weapons,
    });
  });
}

function fixtureMatch(overrides: Partial<ProgramMatch> = {}): ProgramMatch {
  return {
    matchId: 'fixture-match-bo3',
    competition: {
      competitionId: 'fixture-competition',
      slug: 'fixture-spring-major',
      name: 'Fixture Spring Major',
      themeColor: null,
    },
    format: 'bo3',
    stage: 'Playoffs',
    ...overrides,
  };
}

const SERIES_ENTRANTS: ProgramSeries['entrants'] = {
  a: { entryId: 'fixture-entry-a', name: 'Northstar', logoUrl: null },
  b: { entryId: 'fixture-entry-b', name: 'Southpoint', logoUrl: null },
};

function seriesMap(
  overrides: Partial<ProgramSeries['maps'][number]> &
    Pick<ProgramSeries['maps'][number], 'mapOrder' | 'mapName'>,
): ProgramSeries['maps'][number] {
  const { mapOrder, mapName, ...rest } = overrides;
  return {
    mapId: null,
    mapOrder,
    mapName,
    selection: { kind: 'unknown' },
    teamAStartSide: null,
    status: 'pending',
    finalScore: null,
    winnerEntryId: null,
    ...rest,
  };
}

function completeRoundHistory(
  count = 12,
  entrants: ProgramSeries['entrants'] = SERIES_ENTRANTS,
  mapOrder = 2,
): NonNullable<ProgramSeries['roundHistory']> {
  return {
    mapOrder,
    completeness: 'complete',
    rounds: Array.from({ length: count }, (_, index) => {
      const winnerIsA = index % 2 === 0;
      return {
        roundNumber: index + 1,
        winnerSide: index % 3 === 0 ? 'CT' : 'T',
        winnerEntryId: winnerIsA ? entrants.a.entryId : entrants.b.entryId,
        winCondition: index % 3 === 0 ? 'elimination' : 'time',
      };
    }),
  };
}

function makeSeries({
  format = 'bo3',
  entrants = SERIES_ENTRANTS,
  score = { a: 1, b: 0 },
  currentMapOrder = 2,
  maps,
  roundHistory,
}: {
  readonly format?: ProgramSeries['format'];
  readonly entrants?: ProgramSeries['entrants'];
  readonly score?: ProgramSeries['score'];
  readonly currentMapOrder?: number | null;
  readonly maps: readonly ProgramSeries['maps'][number][];
  readonly roundHistory?: ProgramSeries['roundHistory'];
}): ProgramSeries {
  const resolvedRoundHistory =
    roundHistory ?? completeRoundHistory(12, entrants, currentMapOrder ?? 1);
  return {
    format,
    requiredWins: format === 'bo1' ? 1 : format === 'bo3' ? 2 : 3,
    entrants,
    score,
    status: 'live',
    bindingState: 'bound',
    currentMapOrder,
    maps: [...maps],
    veto: [],
    roundHistory: resolvedRoundHistory,
  };
}

const BO3_SERIES = makeSeries({
  maps: [
    seriesMap({
      mapId: 'fixture-map-1',
      mapOrder: 1,
      mapName: 'de_ancient',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.a.entryId },
      teamAStartSide: 'CT',
      status: 'completed',
      finalScore: { a: 13, b: 9 },
      winnerEntryId: SERIES_ENTRANTS.a.entryId,
    }),
    seriesMap({
      mapId: 'fixture-map-2',
      mapOrder: 2,
      mapName: 'de_mirage',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.b.entryId },
      teamAStartSide: 'T',
      status: 'current',
    }),
    seriesMap({
      mapId: 'fixture-map-3',
      mapOrder: 3,
      mapName: 'de_nuke',
      selection: { kind: 'decider' },
      teamAStartSide: 'CT',
      status: 'pending',
    }),
  ],
});

const BO3_MAP1_SERIES = makeSeries({
  score: { a: 0, b: 0 },
  currentMapOrder: 1,
  maps: [
    seriesMap({
      mapId: 'fixture-map1-current',
      mapOrder: 1,
      mapName: 'de_ancient',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.a.entryId },
      teamAStartSide: 'CT',
      status: 'current',
    }),
    seriesMap({
      mapId: 'fixture-map1-next',
      mapOrder: 2,
      mapName: 'de_mirage',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.b.entryId },
      teamAStartSide: 'T',
      status: 'pending',
    }),
    seriesMap({
      mapId: 'fixture-map1-decider',
      mapOrder: 3,
      mapName: 'de_nuke',
      selection: { kind: 'decider' },
      teamAStartSide: 'CT',
      status: 'pending',
    }),
  ],
});

const BO1_SERIES = makeSeries({
  format: 'bo1',
  score: { a: 0, b: 0 },
  currentMapOrder: 1,
  roundHistory: completeRoundHistory(8),
  maps: [
    seriesMap({
      mapId: 'fixture-bo1-map',
      mapOrder: 1,
      mapName: 'de_vertigo',
      selection: { kind: 'unknown' },
      status: 'current',
    }),
  ],
});

const BO5_SERIES = makeSeries({
  format: 'bo5',
  score: { a: 1, b: 1 },
  currentMapOrder: 3,
  maps: [
    seriesMap({
      mapId: 'fixture-bo5-map-1',
      mapOrder: 1,
      mapName: 'de_ancient',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.a.entryId },
      teamAStartSide: 'CT',
      status: 'completed',
      finalScore: { a: 13, b: 11 },
      winnerEntryId: SERIES_ENTRANTS.a.entryId,
    }),
    seriesMap({
      mapId: 'fixture-bo5-map-2',
      mapOrder: 2,
      mapName: 'de_anubis',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.b.entryId },
      teamAStartSide: 'T',
      status: 'completed',
      finalScore: { a: 8, b: 13 },
      winnerEntryId: SERIES_ENTRANTS.b.entryId,
    }),
    seriesMap({
      mapId: 'fixture-bo5-map-3',
      mapOrder: 3,
      mapName: 'de_inferno',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.a.entryId },
      teamAStartSide: 'T',
      status: 'current',
    }),
    seriesMap({
      mapId: 'fixture-bo5-map-4',
      mapOrder: 4,
      mapName: 'de_mirage',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.b.entryId },
      teamAStartSide: 'CT',
      status: 'pending',
    }),
    seriesMap({
      mapId: 'fixture-bo5-map-5',
      mapOrder: 5,
      mapName: 'de_nuke',
      selection: { kind: 'decider' },
      teamAStartSide: 'T',
      status: 'pending',
    }),
  ],
});

const BO5_PICK_LOSS_SERIES = makeSeries({
  format: 'bo5',
  score: { a: 2, b: 0 },
  currentMapOrder: 3,
  maps: BO5_SERIES.maps.map((map) =>
    map.mapOrder === 2
      ? {
          ...map,
          finalScore: { a: 13, b: 8 },
          winnerEntryId: SERIES_ENTRANTS.a.entryId,
        }
      : map,
  ),
});

const NOT_PLAYED_SERIES = makeSeries({
  format: 'bo5',
  score: { a: 1, b: 0 },
  currentMapOrder: 3,
  maps: BO5_SERIES.maps.map((map) =>
    map.mapOrder === 4 ? { ...map, status: 'not_played' as const } : map,
  ),
});

const MIXED_LOGO_URL =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2228%22 viewBox=%220 0 28 28%22%3E%3Crect width=%2228%22 height=%2228%22 rx=%224%22 fill=%22%23888888%22/%3E%3C/svg%3E';
const MIXED_LOGO_ENTRANTS: ProgramSeries['entrants'] = {
  a: { ...SERIES_ENTRANTS.a, logoUrl: MIXED_LOGO_URL },
  b: SERIES_ENTRANTS.b,
};

const MIXED_LOGO_SERIES = makeSeries({
  entrants: MIXED_LOGO_ENTRANTS,
  maps: BO3_SERIES.maps,
});

const OVERTIME_HISTORY_SERIES = makeSeries({
  maps: BO3_SERIES.maps,
  roundHistory: completeRoundHistory(36),
});

const DECIDER_SERIES = makeSeries({
  score: { a: 1, b: 1 },
  currentMapOrder: 3,
  maps: [
    seriesMap({
      mapId: 'fixture-decider-map-1',
      mapOrder: 1,
      mapName: 'de_ancient',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.a.entryId },
      teamAStartSide: 'CT',
      status: 'completed',
      finalScore: { a: 13, b: 6 },
      winnerEntryId: SERIES_ENTRANTS.a.entryId,
    }),
    seriesMap({
      mapId: 'fixture-decider-map-2',
      mapOrder: 2,
      mapName: 'de_anubis',
      selection: { kind: 'pick', entryId: SERIES_ENTRANTS.b.entryId },
      teamAStartSide: 'T',
      status: 'completed',
      finalScore: { a: 10, b: 13 },
      winnerEntryId: SERIES_ENTRANTS.b.entryId,
    }),
    seriesMap({
      mapId: 'fixture-decider-map-3',
      mapOrder: 3,
      mapName: 'de_nuke',
      selection: { kind: 'decider' },
      teamAStartSide: 'CT',
      status: 'current',
    }),
  ],
});

const PARTIAL_HISTORY_SERIES = makeSeries({
  maps: BO3_SERIES.maps,
  roundHistory: {
    mapOrder: 2,
    completeness: 'partial',
    rounds: [
      {
        roundNumber: 3,
        winnerSide: 'CT',
        winnerEntryId: SERIES_ENTRANTS.a.entryId,
        winCondition: 'elimination',
      },
      {
        roundNumber: 5,
        winnerSide: 'unknown',
        winnerEntryId: SERIES_ENTRANTS.b.entryId,
        winCondition: 'unknown',
      },
    ],
  },
});

const UNAVAILABLE_HISTORY_SERIES = makeSeries({
  maps: BO3_SERIES.maps,
  roundHistory: { mapOrder: 2, completeness: 'unavailable', rounds: [] },
});

const LONG_SERIES: ProgramSeries = makeSeries({
  format: 'bo5',
  score: { a: 2, b: 1 },
  currentMapOrder: 4,
  entrants: {
    a: {
      entryId: 'fixture-entry-long-a',
      name: 'Northstar International Academy Development Roster',
      logoUrl: null,
    },
    b: {
      entryId: 'fixture-entry-long-b',
      name: 'Southpoint Competitive Collective Select Division',
      logoUrl: null,
    },
  },
  maps: [
    seriesMap({
      mapOrder: 1,
      mapName: 'de_ancient',
      status: 'completed',
      finalScore: { a: 13, b: 11 },
      winnerEntryId: 'fixture-entry-long-a',
    }),
    seriesMap({
      mapOrder: 2,
      mapName: 'de_anubis',
      status: 'completed',
      finalScore: { a: 10, b: 13 },
      winnerEntryId: 'fixture-entry-long-b',
    }),
    seriesMap({
      mapOrder: 3,
      mapName: 'de_inferno',
      status: 'completed',
      finalScore: { a: 13, b: 9 },
      winnerEntryId: 'fixture-entry-long-a',
    }),
    seriesMap({ mapOrder: 4, mapName: 'de_mirage', status: 'current' }),
    seriesMap({
      mapOrder: 5,
      mapName: 'de_nuke',
      selection: { kind: 'decider' },
      status: 'pending',
    }),
  ],
});

function makeLivePayload({
  context = 'unbound',
  identity = 'unbound',
  match = null,
  teams = { ct: neutralTeam('CT'), t: neutralTeam('T') },
  series = null,
  players = observedPlayers(),
  mapName = 'de_ancient',
  mapMode = 'competitive',
  mapPhase = 'live',
  roundNumber = 12,
  score = { ct: 6, t: 5 },
  round = { phase: 'live', winnerSide: 'unknown' },
  clock = { phase: 'live', endsInSeconds: 74 },
  observedPlayerSourceId = players[0]?.sourcePlayerId ?? null,
  bomb = null,
  coverage = LIVE_COVERAGE,
}: {
  readonly context?: LiveStatus['context'];
  readonly identity?: LiveStatus['identity'];
  readonly match?: ProgramPayload['match'];
  readonly teams?: ProgramPayload['teams'];
  readonly series?: ProgramPayload['series'];
  readonly players?: ProgramPlayer[];
  readonly mapName?: string | null;
  readonly mapMode?: string | null;
  readonly mapPhase?: ProgramPayload['map']['phase'];
  readonly roundNumber?: number | null;
  readonly score?: ProgramPayload['map']['score'];
  readonly round?: ProgramPayload['round'];
  readonly clock?: ProgramPayload['clock'];
  readonly observedPlayerSourceId?: string | null;
  readonly bomb?: ProgramPayload['bomb'];
  readonly coverage?: ProgramPayload['coverage'];
} = {}): ProgramPayload {
  return {
    bombDamage: { status: 'unavailable', reason: 'fixture', model: null, players: [] },
    status: { telemetry: 'fresh', context, identity },
    match,
    teams,
    series,
    map: {
      name: mapName,
      mode: mapMode,
      phase: mapPhase,
      roundNumber,
      score,
      timeoutsRemaining: { ct: 1, t: 2 },
      consecutiveRoundLosses: { ct: 2, t: 3 },
    },
    round,
    clock,
    observedPlayerSourceId,
    players,
    bomb,
    coverage,
  };
}

function makeSnapshot(payload: ProgramPayload): ProgramSnapshot {
  return programSnapshotSchema.parse({
    type: 'snapshot',
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    channel: 'program',
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    channelSeq: 1,
    cursor: FIXTURE_CURSOR,
    payload,
  });
}

function awaitingPayload(): ProgramPayload {
  return {
    bombDamage: { status: 'unavailable', reason: 'fixture', model: null, players: [] },
    status: { telemetry: 'awaiting', context: 'unbound', identity: 'unbound' },
    match: null,
    teams: { ct: neutralTeam('CT'), t: neutralTeam('T') },
    series: null,
    map: {
      name: null,
      mode: null,
      phase: null,
      roundNumber: null,
      score: { ct: null, t: null },
      timeoutsRemaining: { ct: null, t: null },
      consecutiveRoundLosses: { ct: null, t: null },
    },
    round: null,
    clock: null,
    observedPlayerSourceId: null,
    players: [],
    bomb: null,
    coverage: {
      map: 'absent',
      round: 'absent',
      phaseCountdowns: 'absent',
      player: 'absent',
      allPlayers: 'absent',
      bomb: 'absent',
    },
  };
}

const canonicalTeams = {
  ct: canonicalTeam('fixture-entry-a', 'Northstar', 1),
  t: canonicalTeam('fixture-entry-b', 'Southpoint', 0),
};

const staleCanonicalTeams = {
  ct: canonicalTeam('fixture-entry-a', 'Northstar', null),
  t: canonicalTeam('fixture-entry-b', 'Southpoint', null),
};

const degradedPlayers = observedPlayers().map((player, index) => {
  if (index >= 2) return player;
  const side = index < 5 ? 'ct' : 't';
  const playerSide = index < 5 ? 'CT' : 'T';
  return makePlayer(player.sourcePlayerId, playerSide, index + 1, {
    canonicalPlayerId: `fixture-canonical-${side}-${index}`,
    identityEvidence: 'canonical',
    displayName: `Partially verified ${player.side} ${index + 1}`,
    displayNameSource: 'canonical',
    state: player.state,
    matchStats: player.matchStats,
    weapons: player.weapons,
  });
});

const stressPlayers = [
  'AsterionLongNameAlpha',
  'BorealisLongNameBravo',
  'CinderblockLongNameCharlie',
  'DriftwoodLongNameDelta',
  'EmberglassLongNameEcho',
  'FrostlineLongNameFoxtrot',
  'GraniteLongNameGolf',
  'HalcyonLongNameHotel',
  'IronwoodLongNameIndia',
  'JuniperLongNameJuliett',
].map((displayName, index) => {
  const side = index < 5 ? 'CT' : 'T';
  const health = [100, 24, 0, null, 76][index % 5] ?? null;
  const state: PlayerState = {
    ...DEFAULT_PLAYER_STATE,
    health,
    armor: [100, 62, 0, null, 18][index % 5] ?? null,
    hasHelmet: [true, false, false, false, true][index % 5] ?? false,
    hasDefuser: side === 'CT' && index % 2 === 0,
    flashed: index === 1 ? 1.2 : 0,
    smoked: index === 7 ? 4.5 : 0,
    burning: index === 2 ? 2.1 : 0,
    money: [16_000, 2_400, 0, null, 8_750][index % 5] ?? null,
    roundTotalDamage: [128, 64, 0, null, 91][index % 5] ?? null,
    roundKills: [2, 1, 0, null, 3][index % 5] ?? null,
    roundKillHeadshots: [1, 0, 0, null, 2][index % 5] ?? null,
    equipValue: [5_400, 2_200, 0, null, 4_800][index % 5] ?? null,
  };
  return makePlayer(`stress-player-${index + 1}`, side, index + 1, {
    canonicalPlayerId: `stress-canonical-player-${index + 1}`,
    identityEvidence: 'canonical',
    displayName,
    displayNameSource: 'canonical',
    lifeState: (['alive', 'alive', 'dead', 'unknown', 'alive'] as const)[index % 5]!,
    state,
    matchStats: {
      kills: [18, 11, 4, null, 22][index % 5] ?? null,
      assists: [6, 2, 0, null, 7][index % 5] ?? null,
      deaths: [9, 13, 16, null, 5][index % 5] ?? null,
      mvps: [3, 1, 0, null, 4][index % 5] ?? null,
      score: [24, 15, 5, null, 31][index % 5] ?? null,
    },
    weapons:
      index === 0
        ? [
            makeWeapon(`stress-weapon-${index + 1}`, 'weapon_ak47', 'active'),
            makeUtilityWeapon(`stress-smoke-${index + 1}`, 'weapon_smokegrenade', 1),
            makeUtilityWeapon(`stress-fire-${index + 1}`, 'weapon_molotov', 1),
            makeUtilityWeapon(`stress-flash-${index + 1}`, 'weapon_flashbang', 2),
            makeUtilityWeapon(`stress-he-${index + 1}`, 'weapon_hegrenade', 1),
            makeUtilityWeapon(`stress-zeus-${index + 1}`, 'weapon_taser', null),
          ]
        : index === 1
          ? [
              makeWeapon(`stress-weapon-${index + 1}`, 'weapon_m4a1_silencer', 'active'),
              {
                ...makeWeapon(`stress-pistol-${index + 1}`, 'weapon_usp_silencer', 'holstered'),
                type: 'pistol',
                ammoClip: 12,
                ammoClipMax: 12,
                ammoReserve: 24,
              },
              makeUtilityWeapon(`stress-flash-${index + 1}`, 'weapon_flashbang', 2),
            ]
          : index === 4
            ? [
                {
                  ...makeWeapon(`stress-pistol-${index + 1}`, 'weapon_usp_silencer', 'holstered'),
                  type: 'pistol',
                  ammoClip: 12,
                  ammoClipMax: 12,
                  ammoReserve: 24,
                },
              ]
            : index === 3
              ? []
              : [makeWeapon(`stress-weapon-${index + 1}`, 'weapon_ak47', 'active')],
    weaponsAvailable: index !== 3,
    currentRoundDamage: [128, 64, 96, null, 91][index % 5] ?? null,
    liveAdr: [81.2, 76.4, 74.3, null, 91.2][index % 5] ?? null,
    roundMoneySpent: [0, 1_800, 2_400, null, 950][index % 5] ?? null,
  });
});

const freezetimePlayers = stressPlayers.map((player, index) =>
  makePlayer(
    player.sourcePlayerId,
    player.side === 'T' ? 'T' : 'CT',
    player.observerSlot ?? index + 1,
    {
      ...player,
      lifeState: 'alive',
      weaponsAvailable: true,
      state: {
        ...DEFAULT_PLAYER_STATE,
        health: 100,
        armor: index === 1 ? 50 : 100,
        hasHelmet: index !== 1,
        hasDefuser: player.side === 'CT' && index === 0,
        money: [16_000, 2_400, 4_200, 4_200, 8_750][index] ?? 4_200,
        equipValue: [5_400, 2_200, 3_900, 3_900, 4_800][index] ?? 3_900,
      },
      weapons: [
        makeWeapon(
          `freeze-primary-${index + 1}`,
          index % 2 === 0 ? 'weapon_ak47' : 'weapon_m4a1_silencer',
          'active',
        ),
        {
          ...makeWeapon(`freeze-secondary-${index + 1}`, 'weapon_usp_silencer', 'holstered'),
          type: 'pistol',
          ammoClip: 12,
          ammoClipMax: 12,
          ammoReserve: 24,
        },
        makeUtilityWeapon(`freeze-smoke-${index + 1}`, 'weapon_smokegrenade', index === 2 ? 0 : 1),
        makeUtilityWeapon(`freeze-flash-${index + 1}`, 'weapon_flashbang', index === 3 ? null : 2),
      ],
    },
  ),
);

const ecoPlayers = freezetimePlayers.map((player, index) => ({
  ...player,
  state:
    player.state === null
      ? null
      : {
          ...player.state,
          armor: 0,
          hasHelmet: false,
          hasDefuser: false,
          money: 1_400,
          equipValue: 0,
        },
  weapons:
    index % 2 === 0
      ? [
          {
            ...makeWeapon(`eco-pistol-${index + 1}`, 'weapon_glock', 'active'),
            type: 'pistol' as const,
            ammoClip: 20,
            ammoClipMax: 20,
            ammoReserve: 120,
          },
        ]
      : [],
  roundMoneySpent: 0,
}));

const missingSummaryPlayers = freezetimePlayers.map((player, index) =>
  index === 0
    ? {
        ...player,
        state: player.state === null ? null : { ...player.state, money: null, equipValue: null },
        weapons: [],
        weaponsAvailable: false,
        roundMoneySpent: null,
      }
    : player,
);

const carryoverLivePlayers = freezetimePlayers.map((player) => ({
  ...player,
  state: player.state === null ? null : { ...player.state, money: 1_000, equipValue: 500 },
  roundMoneySpent: null,
}));

const stressMatch = fixtureMatch({
  format: 'bo5',
  competition: {
    competitionId: 'fixture-competition-stress',
    slug: 'fixture-long-label-competition',
    name: 'International Championship Qualifier With An Intentionally Long Competition Name',
    themeColor: null,
  },
  stage: 'Long Stage Name For Overflow And Layout Regression Coverage',
});

const presentationFixtureReplaySources = new WeakMap<ProgramSnapshot, RealProgramFixtureId>();

function presentationFixture(
  id: RealProgramFixtureId,
  series: ProgramSeries,
  extra: Omit<PresentationStressPatch, 'series'> = {},
): ProgramSnapshot {
  const base = realProgramFixtures[id].snapshot;
  const entrants = base.payload.series!.entrants;
  const entryId = (id: string | null) =>
    id === series.entrants.a.entryId
      ? entrants.a.entryId
      : id === series.entrants.b.entryId
        ? entrants.b.entryId
        : id;
  const fixture = derivePresentationStressFixture(base, {
    teamAName: series.entrants.a.name,
    teamBName: series.entrants.b.name,
    teamALogoUrl: series.entrants.a.logoUrl,
    teamBLogoUrl: series.entrants.b.logoUrl,
    ...extra,
    series: {
      format: series.format,
      requiredWins: series.requiredWins,
      score: series.score,
      status: series.status,
      bindingState: series.bindingState,
      currentMapOrder: series.currentMapOrder,
      maps: series.maps.map((map) => ({
        ...map,
        winnerEntryId: entryId(map.winnerEntryId),
        selection:
          map.selection.kind === 'pick'
            ? { ...map.selection, entryId: entryId(map.selection.entryId)! }
            : map.selection,
      })),
      veto: series.veto.map((step) => ({ ...step, entryId: entryId(step.entryId) })),
    },
  });
  presentationFixtureReplaySources.set(fixture, id);
  return fixture;
}

/** Stable sample mapping pairs real BP with gameplay captures without claiming one match. */
export const HUD_EDITOR_REAL_BP_FIXTURES = {
  'real-live-rich': presentationFixture(
    'real-live-rich',
    rivalsSeriesCut(RIVALS_BP_RECORDS.final, 4),
  ),
  'real-bomb-dropped': presentationFixture(
    'real-bomb-dropped',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalA, null),
  ),
  'real-planted': presentationFixture(
    'real-planted',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalB, null),
  ),
  'real-defusing': presentationFixture(
    'real-defusing',
    rivalsSeriesCut(RIVALS_BP_RECORDS.final, 4),
  ),
  'real-post-explosion-freezetime': presentationFixture(
    'real-post-explosion-freezetime',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalA, null),
  ),
  'real-timeout-ct': presentationFixture(
    'real-timeout-ct',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalB, null),
  ),
  'real-halftime-after': presentationFixture(
    'real-halftime-after',
    rivalsSeriesCut(RIVALS_BP_RECORDS.final, null),
  ),
  'real-gameover': presentationFixture(
    'real-gameover',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalA, null),
  ),
} as const satisfies Partial<Record<RealProgramFixtureId, ProgramSnapshot>>;

export function getPresentationFixtureReplaySource(
  snapshot: ProgramSnapshot,
): RealProgramFixtureId | null {
  return presentationFixtureReplaySources.get(snapshot) ?? null;
}

export const syntheticProgramFixtures = {
  'awaiting-neutral': makeSnapshot(awaitingPayload()),
  'live-neutral': makeSnapshot(
    makeLivePayload({
      context: 'unbound',
      identity: 'unbound',
      score: { ct: 3, t: 2 },
      roundNumber: 6,
      clock: { phase: 'live', endsInSeconds: 51 },
    }),
  ),
  'context-stale': makeSnapshot(
    makeLivePayload({
      context: 'stale',
      identity: 'matched',
      match: fixtureMatch(),
      teams: staleCanonicalTeams,
      players: canonicalPlayers(),
      observedPlayerSourceId: 'fixture-player-t-8',
      clock: { phase: 'live', endsInSeconds: 38 },
    }),
  ),
  'identity-degraded': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'degraded',
      match: fixtureMatch(),
      teams: { ct: neutralTeam('CT'), t: neutralTeam('T') },
      players: degradedPlayers,
      coverage: { ...LIVE_COVERAGE, allPlayers: 'degraded' },
    }),
  ),
  'identity-mismatch': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'mismatch',
      match: fixtureMatch(),
      teams: { ct: neutralTeam('CT'), t: neutralTeam('T') },
      players: observedPlayers(),
      observedPlayerSourceId: 'fixture-player-t-10',
    }),
  ),
  'stress-long-labels': presentationFixture('real-live-rich', LONG_SERIES, {
    playerNames: Object.fromEntries(
      realProgramFixtures['real-live-rich'].snapshot.payload.players.map((player, index) => [
        player.sourcePlayerId,
        stressPlayers[index]!.displayName,
      ]),
    ),
    competitionName: stressMatch.competition?.name ?? '',
    stage: stressMatch.stage ?? '',
  }),
  'player-rails-eco': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch({ format: 'bo1' }),
      teams: canonicalTeams,
      series: BO1_SERIES,
      players: ecoPlayers,
      mapName: 'de_vertigo',
      roundNumber: 8,
      score: { ct: 4, t: 4 },
      round: { phase: 'freezetime', winnerSide: 'unknown' },
      clock: { phase: 'freezetime', endsInSeconds: 12 },
    }),
  ),
  'player-rails-dead-observed': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: stressMatch,
      teams: canonicalTeams,
      series: LONG_SERIES,
      players: stressPlayers,
      roundNumber: 19,
      score: { ct: 10, t: 8 },
      clock: { phase: 'live', endsInSeconds: 17 },
      observedPlayerSourceId: 'stress-player-3',
      bomb: {
        state: 'carried',
        sourcePlayerId: 'stress-player-6',
        explosion: null,
        action: null,
      },
      coverage: BOMB_COVERAGE,
    }),
  ),
  'player-rails-missing-summary': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch({ format: 'bo1' }),
      teams: canonicalTeams,
      series: BO1_SERIES,
      players: missingSummaryPlayers,
      mapName: 'de_vertigo',
      roundNumber: 8,
      score: { ct: 4, t: 4 },
      round: { phase: 'freezetime', winnerSide: 'unknown' },
      clock: { phase: 'freezetime', endsInSeconds: 12 },
    }),
  ),
  'player-rails-carryover': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch({ format: 'bo1' }),
      teams: canonicalTeams,
      series: BO1_SERIES,
      players: carryoverLivePlayers,
      mapName: 'de_vertigo',
      roundNumber: 8,
      score: { ct: 4, t: 4 },
      round: { phase: 'live', winnerSide: 'unknown' },
      clock: { phase: 'live', endsInSeconds: 74 },
    }),
  ),
  'series-bo1': presentationFixture('real-post-explosion-freezetime', BO1_SERIES),
  'series-bo3-map1': presentationFixture('real-live-rich', BO3_MAP1_SERIES),
  'series-bo5': presentationFixture('real-live-rich', BO5_SERIES),
  'series-bo5-pick-loss': presentationFixture('real-live-rich', BO5_PICK_LOSS_SERIES),
  'bp-rivals-final-map4': presentationFixture(
    'real-live-rich',
    rivalsSeriesCut(RIVALS_BP_RECORDS.final, 4),
  ),
  'bp-rivals-final-result': presentationFixture(
    'real-live-rich',
    rivalsSeriesCut(RIVALS_BP_RECORDS.final, null),
  ),
  'bp-rivals-semi-a-result': presentationFixture(
    'real-live-rich',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalA, null),
  ),
  'bp-rivals-semi-b-result': presentationFixture(
    'real-live-rich',
    rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalB, null),
  ),
  'series-not-played': presentationFixture('real-live-rich', NOT_PLAYED_SERIES),
  'series-logo-mixed': presentationFixture('real-live-rich', MIXED_LOGO_SERIES),
  'series-decider': presentationFixture('real-live-rich', DECIDER_SERIES),
  'series-partial-history': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch(),
      teams: canonicalTeams,
      series: PARTIAL_HISTORY_SERIES,
      players: canonicalPlayers(),
      mapName: 'de_mirage',
      roundNumber: 5,
      score: { ct: 3, t: 2 },
      clock: { phase: 'live', endsInSeconds: 51 },
    }),
  ),
  'series-history-unavailable': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch(),
      teams: canonicalTeams,
      series: UNAVAILABLE_HISTORY_SERIES,
      players: canonicalPlayers(),
      mapName: 'de_mirage',
      roundNumber: 5,
      score: { ct: 3, t: 2 },
      clock: { phase: 'live', endsInSeconds: 51 },
    }),
  ),
  'series-mapping-unavailable': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'degraded',
      match: fixtureMatch(),
      teams: { ct: neutralTeam('CT'), t: neutralTeam('T') },
      series: BO3_SERIES,
      players: canonicalPlayers(),
      mapName: 'de_mirage',
      roundNumber: 13,
      score: { ct: 7, t: 5 },
      clock: { phase: 'timeout_ct', endsInSeconds: 22 },
    }),
  ),
  'series-round-unavailable': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch(),
      teams: canonicalTeams,
      series: BO3_SERIES,
      players: canonicalPlayers(),
      mapName: 'de_mirage',
      roundNumber: null,
      score: { ct: 7, t: 5 },
      clock: { phase: 'live', endsInSeconds: 48 },
    }),
  ),
  'series-overtime-history': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch(),
      teams: canonicalTeams,
      series: OVERTIME_HISTORY_SERIES,
      players: canonicalPlayers(),
      mapName: 'de_mirage',
      roundNumber: 36,
      score: { ct: 15, t: 14 },
      clock: { phase: 'live', endsInSeconds: 48 },
    }),
  ),
  'series-long-labels': presentationFixture('real-live-rich', LONG_SERIES, {
    playerNames: Object.fromEntries(
      realProgramFixtures['real-live-rich'].snapshot.payload.players.map((player, index) => [
        player.sourcePlayerId,
        stressPlayers[index]!.displayName,
      ]),
    ),
    competitionName: stressMatch.competition?.name ?? '',
    stage: stressMatch.stage ?? '',
  }),
  'player-rails-freezetime': makeSnapshot(
    makeLivePayload({
      context: 'fresh',
      identity: 'matched',
      match: fixtureMatch({ format: 'bo1' }),
      teams: canonicalTeams,
      series: BO1_SERIES,
      players: freezetimePlayers,
      mapName: 'de_vertigo',
      roundNumber: 8,
      score: { ct: 4, t: 4 },
      clock: { phase: 'freezetime', endsInSeconds: 12 },
    }),
  ),
} as const;

export const SYNTHETIC_FIXTURE_PROVENANCE = {
  'awaiting-neutral': { kind: 'synthetic-edge', reason: '无 telemetry 的初始空状态。' },
  'live-neutral': { kind: 'synthetic-edge', reason: '未绑定赛事上下文时保留中性本地观测。' },
  'context-stale': { kind: 'synthetic-edge', reason: '赛事上下文过期时的显示边界。' },
  'identity-degraded': { kind: 'synthetic-edge', reason: '仅部分选手身份可确认的降级状态。' },
  'identity-mismatch': {
    kind: 'synthetic-edge',
    reason: '身份矛盾时品牌与 canonical identity fail closed。',
  },
  'stress-long-labels': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'player-rails-eco': {
    kind: 'synthetic-edge',
    reason: '现有 capture 不覆盖精确的全员低装备边界，验证缺装备时的选手栏。',
  },
  'player-rails-dead-observed': {
    kind: 'synthetic-edge',
    reason: '现有 capture 不覆盖精确的阵亡观察目标及缺失统计组合，验证阵亡卡片边界。',
  },
  'player-rails-missing-summary': {
    kind: 'synthetic-edge',
    reason: '缺失武器和经济 evidence 时团队汇总 fail closed。',
  },
  'player-rails-carryover': {
    kind: 'synthetic-edge',
    reason: '精确控制 freezetime 到 live 的五秒经济延续与常驻道具生命周期。',
  },
  'series-bo1': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'series-bo3-map1': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'series-bo5': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'series-bo5-pick-loss': {
    kind: 'synthetic-presentation',
    reason: '以真实 Program snapshot 为底，合成选图方失利的比分与赢家，用于视觉预览。',
  },
  'bp-rivals-final-map4': {
    kind: 'synthetic-presentation',
    reason:
      '2026 NJU Rivals 总决赛官方 BP/赛果，在第 4 图开打前截取；背景 GSI 来自独立真实回放，只验收系列图条。',
  },
  'bp-rivals-final-result': {
    kind: 'synthetic-presentation',
    reason:
      '2026 NJU Rivals 总决赛官方 BP/赛果的赛后切面；背景 GSI 来自独立真实回放，只验收系列图条。',
  },
  'bp-rivals-semi-a-result': {
    kind: 'synthetic-presentation',
    reason: '2026 NJU Rivals 胜者组半决赛官方 BP/赛果；背景 GSI 来自独立真实回放，只验收系列图条。',
  },
  'bp-rivals-semi-b-result': {
    kind: 'synthetic-presentation',
    reason: '2026 NJU Rivals 胜者组半决赛官方 BP/赛果；背景 GSI 来自独立真实回放，只验收系列图条。',
  },
  'series-not-played': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'series-logo-mixed': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'series-decider': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'series-partial-history': {
    kind: 'synthetic-edge',
    reason: '回合历史缺口与未知 winner 的 fail-closed 边界。',
  },
  'series-history-unavailable': {
    kind: 'synthetic-edge',
    reason: '历史 evidence 不可用时隐藏回合历史。',
  },
  'series-mapping-unavailable': {
    kind: 'synthetic-edge',
    reason: '阵营映射不可用时不猜测暂停归属。',
  },
  'series-round-unavailable': {
    kind: 'synthetic-edge',
    reason: '回合编号不可用时不显示伪造编号。',
  },
  'series-overtime-history': {
    kind: 'synthetic-edge',
    reason: '固定 36 回合边界验证有界历史布局；人工 winner 序列不代表真实比赛。',
  },
  'series-long-labels': {
    kind: 'synthetic-presentation',
    reason:
      '以真实 Program snapshot 为底，仅施加系列赛计划、品牌或名称展示压力；计划不是 GSI evidence。',
  },
  'player-rails-freezetime': {
    kind: 'synthetic-edge',
    reason: '为 carryover 生命周期测试提供确定的 freezetime 前置帧。',
  },
} as const;
