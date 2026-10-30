import type { BroadcastStats } from '@mizar/protocol/broadcast-stats';
import type { BroadcastManifest } from '@mizar/rivalhub';
import {
  broadcastStatsPresentationSchema,
  type BroadcastStatsPresentation,
} from '@mizar/protocol/broadcast-stats-presentation';

type Entrant = BroadcastStats['entrants'][number];
type Player = Entrant['playerPerformance']['players'][number];
type Rate = NonNullable<Entrant['pistol']['pistol']>;
type Quantity = NonNullable<Entrant['utility']['utilityDamagePerRound']>;
const attributeKeys = [
  'firepower',
  'entrying',
  'trading',
  'opening',
  'clutching',
  'sniping',
  'utility',
] as const;

/** Bind the unchanged website snapshot to the active match and its canonical starters. */
export function bindHistoricalStats(
  bundle: BroadcastStats,
  manifest: BroadcastManifest,
): BroadcastStats | null {
  if (bundle.matchId !== manifest.match.matchId || bundle.entrants.length !== 2) return null;
  const canonicalTeams = [manifest.entrants.a, manifest.entrants.b];
  const ids = canonicalTeams.map((team) => team.entryId);
  if (
    new Set(ids).size !== 2 ||
    new Set(bundle.entrants.map((team) => team.entryId)).size !== 2 ||
    !ids.every((id) => bundle.entrants.some((team) => team.entryId === id))
  )
    return null;
  const entrants = canonicalTeams.map((canonical) => {
    const entry = bundle.entrants.find((team) => team.entryId === canonical.entryId)!;
    const starters = new Set(
      canonical.roster.players
        .filter((player) => player.isStarter)
        .map((player) => player.playerId),
    );
    return {
      ...entry,
      ...(entry.facts
        ? {
            facts: {
              ...entry.facts,
              players: entry.facts.players.filter((player) => starters.has(player.userId)),
            },
          }
        : {}),
      starters: entry.starters.filter((player) => starters.has(player.userId)),
      playerPerformance: {
        ...entry.playerPerformance,
        players: entry.playerPerformance.players.filter((player) => starters.has(player.userId)),
      },
    };
  });
  return { ...bundle, entrants };
}

/** Select comparable website facts without deriving or recalculating historical statistics.
 * The caller must first bind entrants and starters to the active match. */
export function projectHistoricalStats(bundle: BroadcastStats): BroadcastStatsPresentation | null {
  const [a, b] = bundle.entrants;
  if (!a || !b || a.entryId === b.entryId) return null;
  const teams = [
    { entryId: a.entryId, name: a.name, logoUrl: a.logoUrl },
    { entryId: b.entryId, name: b.name, logoUrl: b.logoUrl },
  ] as const;
  const maps = a.mapPerformance.maps.flatMap((left) => {
    const right = b.mapPerformance.maps.find((map) => map.mapName === left.mapName);
    if (
      !a.mapPerformance.available ||
      !b.mapPerformance.available ||
      !right ||
      left.played <= 0 ||
      right.played <= 0 ||
      left.winRate === null ||
      right.winRate === null ||
      left.wins > left.played ||
      right.wins > right.played
    )
      return [];
    return [
      {
        mapName: left.mapName,
        values: [
          { winRate: left.winRate, played: left.played, wins: left.wins },
          { winRate: right.winRate, played: right.played, wins: right.wins },
        ] as const,
      },
    ];
  });
  const recent =
    a.recentResults.available &&
    b.recentResults.available &&
    a.recentResults.results.length &&
    b.recentResults.results.length
      ? ([a.recentResults.results.slice(0, 5), b.recentResults.results.slice(0, 5)] as const)
      : null;
  const winPair = (left: Rate | null, right: Rate | null) =>
    left &&
    right &&
    left.rate !== null &&
    right.rate !== null &&
    left.opportunities > 0 &&
    right.opportunities > 0 &&
    left.wins <= left.opportunities &&
    right.wins <= right.opportunities
      ? ([
          { rate: left.rate, wins: left.wins, opportunities: left.opportunities },
          { rate: right.rate, wins: right.wins, opportunities: right.opportunities },
        ] as const)
      : null;
  const pistolComparable =
    a.pistol.available && b.pistol.available && a.pistol.scope === b.pistol.scope;
  const pistolRows = pistolComparable
    ? {
        pistol: winPair(a.pistol.pistol, b.pistol.pistol),
        conversion: winPair(a.pistol.conversion, b.pistol.conversion),
        break: winPair(a.pistol.break, b.pistol.break),
      }
    : null;
  const pistol = pistolRows && Object.values(pistolRows).some(Boolean) ? pistolRows : null;
  const economy =
    a.economy.available && b.economy.available && a.economy.scope === b.economy.scope
      ? winPair(a.economy.ecoSemiUpset, b.economy.ecoSemiUpset)
      : null;
  const quantityPair = (left: Quantity | null, right: Quantity | null) =>
    left &&
    right &&
    left.rate !== null &&
    right.rate !== null &&
    left.attempts > 0 &&
    right.attempts > 0
      ? ([
          { rate: left.rate, attempts: left.attempts, successes: left.successes },
          { rate: right.rate, attempts: right.attempts, successes: right.successes },
        ] as const)
      : null;
  const utilityComparable =
    a.utility.available && b.utility.available && a.utility.scope === b.utility.scope;
  const utilityRows = utilityComparable
    ? {
        utilityDamagePerRound: quantityPair(
          a.utility.utilityDamagePerRound,
          b.utility.utilityDamagePerRound,
        ),
        flashAssistsPerRound: quantityPair(
          a.utility.flashAssistsPerRound,
          b.utility.flashAssistsPerRound,
        ),
        enemyBlindSecondsPerFlash: quantityPair(
          a.utility.enemyBlindSecondsPerFlash,
          b.utility.enemyBlindSecondsPerFlash,
        ),
        enemyBlindSecondsPerRound: quantityPair(
          a.utility.enemyBlindSecondsPerRound,
          b.utility.enemyBlindSecondsPerRound,
        ),
      }
    : null;
  const utility = utilityRows && Object.values(utilityRows).some(Boolean) ? utilityRows : null;
  const completeLineup = (entry: Entrant) =>
    entry.starters.length === 5 &&
    new Set(entry.starters.map((player) => player.userId)).size === 5;
  const lineups =
    completeLineup(a) && completeLineup(b) ? ([a.starters, b.starters] as const) : null;
  const focus = (entry: Entrant) =>
    entry.playerPerformance.players
      .filter(
        (player) =>
          entry.starters.some((starter) => starter.userId === player.userId) &&
          player.sample.maps > 0 &&
          player.sample.ratingMaps > 0 &&
          player.sample.ratingMaps <= player.sample.maps &&
          player.rating !== null,
      )
      .sort(
        (x, y) => y.rating! - x.rating! || (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0),
      )[0];
  const left = focus(a),
    right = focus(b);
  const portrait = (player: Player) =>
    player.attributes.available &&
    player.attributes.values.length === 7 &&
    new Set(player.attributes.values.map((item) => item.key)).size === 7 &&
    attributeKeys.every((key) =>
      player.attributes.values.some(
        (item) => item.key === key && item.score !== null && item.status === 'qualified',
      ),
    );
  const selected =
    left && right
      ? ([
          { ...a.starters.find((starter) => starter.userId === left.userId)!, entryId: a.entryId },
          { ...b.starters.find((starter) => starter.userId === right.userId)!, entryId: b.entryId },
        ] as const)
      : null;
  const playerComparison =
    left && right && selected
      ? {
          players: selected,
          rating: [
            { value: left.rating!, sampleMaps: left.sample.ratingMaps },
            { value: right.rating!, sampleMaps: right.sample.ratingMaps },
          ] as const,
          adr:
            left.adr !== null &&
            right.adr !== null &&
            left.sample.adrRounds !== null &&
            left.sample.adrRounds > 0 &&
            right.sample.adrRounds !== null &&
            right.sample.adrRounds > 0
              ? ([
                  { value: left.adr, sampleRounds: left.sample.adrRounds },
                  { value: right.adr, sampleRounds: right.sample.adrRounds },
                ] as const)
              : null,
        }
      : null;
  const playerAttributes =
    left &&
    right &&
    selected &&
    portrait(left) &&
    portrait(right) &&
    left.attributes.benchmark === right.attributes.benchmark &&
    left.attributes.scope === right.attributes.scope
      ? {
          players: selected,
          rounds: [left.attributes.sample.rounds, right.attributes.sample.rounds] as const,
          values: attributeKeys.map((key) => ({
            key,
            values: [
              left.attributes.values.find((item) => item.key === key)!.score!,
              right.attributes.values.find((item) => item.key === key)!.score!,
            ] as const,
          })),
        }
      : null;
  const eligibility = (eligible: boolean) => ({
    eligible,
    reason: eligible ? null : ('missing-data' as const),
  });
  const pages = [];
  for (let start = 0; start < maps.length; start += 7)
    pages.push({ page: start / 7 + 1, rows: maps.slice(start, start + 7) });
  const attributes = playerAttributes
    ? Object.fromEntries(playerAttributes.values.map(({ key, values }) => [key, values]))
    : null;
  return broadcastStatsPresentationSchema.parse({
    schemaVersion: 'mizar.broadcast-stats-presentation.v1',
    matchId: bundle.matchId,
    competitionId: bundle.competitionId,
    sourceRevision: bundle.revision,
    sourceGeneratedAt: bundle.generatedAt,
    teams,
    selectedPlayers: selected,
    maps: { id: 'maps', ...eligibility(pages.length > 0), pages },
    recent: { id: 'recent', ...eligibility(recent !== null), results: recent ?? [[], []] },
    lineups: {
      id: 'lineups',
      ...eligibility(lineups !== null),
      rows: lineups
        ? lineups[0].map((player, i) => [
            { ...player, entryId: a.entryId },
            { ...lineups[1][i]!, entryId: b.entryId },
          ])
        : [],
    },
    pistol: {
      id: 'pistol',
      ...eligibility(pistol !== null),
      pistol: pistol?.pistol ?? null,
      conversion: pistol?.conversion ?? null,
      break: pistol?.break ?? null,
    },
    economy: { id: 'economy', ...eligibility(economy !== null), ecoSemiUpset: economy },
    utility: {
      id: 'utility',
      ...eligibility(utility !== null),
      utilityDamagePerRound: utility?.utilityDamagePerRound ?? null,
      flashAssistsPerRound: utility?.flashAssistsPerRound ?? null,
      enemyBlindSecondsPerFlash: utility?.enemyBlindSecondsPerFlash ?? null,
      enemyBlindSecondsPerRound: utility?.enemyBlindSecondsPerRound ?? null,
    },
    playerComparison: {
      id: 'player-comparison',
      ...eligibility(playerComparison !== null),
      rating: playerComparison?.rating ?? null,
      adr: playerComparison?.adr ?? null,
    },
    playerAttributes: {
      id: 'player-attributes',
      ...eligibility(playerAttributes !== null),
      benchmark: playerAttributes ? 'rivalhub-all-time-qualified' : null,
      scope: playerAttributes ? 'competition' : null,
      sampleRounds: playerAttributes?.rounds ?? null,
      values: attributes,
    },
  });
}
