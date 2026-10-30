import type { BroadcastStats } from '@mizar/protocol/broadcast-stats';

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

/** Select comparable website facts without deriving or recalculating historical statistics.
 * The caller must first bind entrants and starters to the active match. */
export function projectHistoricalStats(bundle: BroadcastStats) {
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
          { value: left.winRate, played: left.played },
          { value: right.winRate, played: right.played },
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
          { value: left.rate, wins: left.wins, opportunities: left.opportunities },
          { value: right.rate, wins: right.wins, opportunities: right.opportunities },
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
          { value: left.rate, attempts: left.attempts },
          { value: right.rate, attempts: right.attempts },
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
          a.starters.find((starter) => starter.userId === left.userId)!,
          b.starters.find((starter) => starter.userId === right.userId)!,
        ] as const)
      : null;
  const playerComparison =
    left && right && selected
      ? {
          players: selected,
          rating: [
            { value: left.rating!, maps: left.sample.ratingMaps },
            { value: right.rating!, maps: right.sample.ratingMaps },
          ] as const,
          adr:
            left.adr !== null &&
            right.adr !== null &&
            left.sample.adrRounds !== null &&
            left.sample.adrRounds > 0 &&
            right.sample.adrRounds !== null &&
            right.sample.adrRounds > 0
              ? ([
                  { value: left.adr, rounds: left.sample.adrRounds },
                  { value: right.adr, rounds: right.sample.adrRounds },
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
  return {
    matchId: bundle.matchId,
    revision: bundle.revision,
    generatedAt: bundle.generatedAt,
    teams,
    topics: { maps, recent, pistol, economy, utility, lineups, playerComparison, playerAttributes },
  };
}
