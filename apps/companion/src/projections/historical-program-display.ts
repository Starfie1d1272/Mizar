import type { BroadcastStats } from '@mizar/protocol/broadcast-stats';
import type { BroadcastStatsProgram } from '@mizar/protocol/broadcast-stats-presentation';

type Team = BroadcastStats['entrants'][number] | null;
type Player = BroadcastStatsProgram['displayPlayers'][number];
type Page = BroadcastStatsProgram['pages'][number];
type Metric = Player['metrics']['rating'];
type Unit = Metric['unit'];
const sides = [0, 1] as const;
const metric = (
  value: number | null | undefined,
  unit: Unit,
  numerator?: number | null,
  denominator?: number | null,
): Metric => ({
  value: value ?? null,
  unit,
  numerator: numerator ?? null,
  denominator: denominator ?? null,
});
const q = (
  source: { rate: number | null; successes: number; attempts: number } | null | undefined,
  unit: Unit,
  scale = 1,
): Metric =>
  metric(
    source?.attempts && source.rate !== null ? source.rate * scale : null,
    unit,
    source?.successes,
    source?.attempts,
  );
const w = (
  source: { rate: number | null; wins: number; opportunities: number } | null | undefined,
): Metric =>
  metric(
    source?.opportunities && source.rate !== null && source.wins <= source.opportunities
      ? source.rate * 100
      : null,
    'percent',
    source?.wins,
    source?.opportunities,
  );
const sampled = (
  source: { value: number | null; rounds: number | null } | null | undefined,
  unit: Unit,
  scale = 1,
): Metric =>
  metric(
    source?.rounds && source.value !== null ? source.value * scale : null,
    unit,
    null,
    source?.rounds,
  );
const empty = (unit: Unit = 'number') => metric(null, unit);
const first = (primary: Metric, fallback: Metric) => (primary.value === null ? fallback : primary);
const per100 = (
  source: { rate: number | null; successes: number; attempts: number } | null | undefined,
) => q(source, 'per100', 100);

export function displayPlayers(
  teams: BroadcastStatsProgram['teams'],
  histories: [Team, Team],
): Player[] {
  return sides.flatMap((side) =>
    teams[side].starters.map((identity) => {
      const performance = histories[side]?.playerPerformance.players.find(
        (p) => p.userId === identity.userId,
      );
      const facts = histories[side]?.facts?.players.find((p) => p.userId === identity.userId);
      const board = facts?.scoreboard;
      const detail = facts?.detailed;
      const rating = metric(performance?.rating, 'number', null, performance?.sample.ratingMaps);
      const adr = metric(performance?.adr, 'number', null, performance?.sample.adrRounds);
      const kast = first(sampled(board?.kast, 'percent', 100), q(detail?.kast, 'percent', 100));
      const attributes = performance?.attributes.values ?? [];
      const profileMode = attributes.some((a) => a.score !== null)
        ? 'attributes'
        : [rating, adr, kast].some((m) => m.value !== null)
          ? 'stats'
          : 'identity';
      const clutch = detail?.clutch;
      const clutchValues = clutch
        ? [
            clutch.winRate,
            ...(['1', '2', '3', '4', '5'] as const).map((n) => clutch.byOpponentCount[n]),
          ].map((v, opponents) => ({ opponents, metric: q(v, 'percent', 100) }))
        : [];
      const totalMulti = detail
        ? detail.twoKillRounds +
          detail.threeKillRounds +
          detail.fourKillRounds +
          detail.fiveKillRounds
        : null;
      const multiFallback = metric(
        detail?.sample.rounds && totalMulti !== null
          ? (totalMulti / detail.sample.rounds) * 100
          : null,
        'per100',
        totalMulti,
        detail?.sample.rounds,
      );
      return {
        ...identity,
        teamIndex: side,
        maps: performance?.sample.maps ?? facts?.maps ?? null,
        rounds: performance?.sample.rounds ?? facts?.rounds ?? null,
        metrics: {
          rating,
          adr,
          kpr: first(sampled(board?.kpr, 'per-round'), q(detail?.killsPerRound, 'per-round')),
          kast,
          opening: q(detail?.openingSuccess, 'percent', 100),
          trade: first(sampled(board?.tradeKpr, 'per100', 100), per100(detail?.tradeKillsPerRound)),
          multikill: first(sampled(board?.mkpr, 'per100', 100), multiFallback),
          headshot: first(
            metric(
              board?.avgHs.kills && board.avgHs.value !== null ? board.avgHs.value : null,
              'percent',
              null,
              board?.avgHs.kills,
            ),
            q(detail?.headshotRate, 'percent', 100),
          ),
          kd: first(
            metric(
              board?.kd.deaths && board.kd.value !== null ? board.kd.value : null,
              'number',
              null,
              board?.kd.deaths,
            ),
            metric(facts?.kd, 'number'),
          ),
        },
        attributes: attributes.filter((item) => item.score !== null),
        profileMode,
        limited: attributes.some((a) => a.status === 'limited'),
        clutch: clutchValues,
      };
    }),
  );
}

type Map = Page['maps'][number];
function mapsFor(names: string[], histories: [Team, Team]): Map[] {
  const key = (name: string) => name.toLowerCase().replace(/^de_/, '');
  return names.map((name) => ({
    name,
    sides: sides.map((side) => {
      const team = histories[side];
      const perf = team?.mapPerformance.maps.find((m) => key(m.mapName) === key(name));
      const detail = team?.facts?.maps.find((m) => key(m.mapName) === key(name));
      const played = detail?.results?.played ?? perf?.played ?? null;
      const wins = detail?.results?.wins ?? perf?.wins ?? null;
      const losses =
        detail?.results?.losses ??
        (played !== null && wins !== null && wins <= played ? played - wins : null);
      return {
        played,
        wins,
        losses,
        winRate: metric(
          perf?.played && perf.wins <= perf.played && perf.winRate !== null
            ? perf.winRate * 100
            : null,
          'percent',
          wins,
          played,
        ),
        rounds: detail?.rounds
          ? metric(
              detail.rounds.rounds && detail.rounds.rate !== null ? detail.rounds.rate * 100 : null,
              'percent',
              detail.rounds.wins,
              detail.rounds.rounds,
            )
          : empty('percent'),
        ct: w(detail?.rounds?.ct),
        t: w(detail?.rounds?.t),
        picks: detail?.selection?.picks ?? null,
        bans: detail?.selection?.bans ?? null,
        deciders: detail?.selection?.deciders ?? null,
      };
    }) as Map['sides'],
  }));
}

function teamMetric(team: Team, key: string): Metric {
  const facts = team?.facts;
  const u = facts?.utility;
  const awp = facts?.weapons?.find((weapon) => weapon.weapon.toUpperCase() === 'AWP');
  const knownMissingAwp =
    facts?.weaponsCoverage?.completeness === 'complete' && facts.weapons !== null && !awp;
  switch (key) {
    case 'rating':
      return metric(facts?.teamRating?.rating, 'number', null, facts?.teamRating?.ratingSamples);
    case 'round-win':
      return facts?.rounds
        ? metric(
            facts.rounds.rounds && facts.rounds.rate !== null ? facts.rounds.rate * 100 : null,
            'percent',
            facts.rounds.wins,
            facts.rounds.rounds,
          )
        : empty('percent');
    case 'ct':
      return w(facts?.rounds?.ct);
    case 't':
      return w(facts?.rounds?.t);
    case 'pistol':
      return w(team?.pistol.pistol);
    case 'pistol-conversion':
      return w(team?.pistol.conversion);
    case 'pistol-break':
      return w(team?.pistol.break);
    case 'opening':
      return q(facts?.opening?.successRate, 'percent', 100);
    case 'win-after-opening':
      return q(facts?.opening?.winAfterOpening, 'percent', 100);
    case 'trade':
      return per100(facts?.opening?.tradeKillsPerRound);
    case 'opening-death-traded':
      return q(facts?.opening?.openingDeathTraded, 'percent', 100);
    case '5v4':
    case '4v5':
    case '5v3':
    case '3v5':
      return w(facts?.manAdvantage?.[key]);
    case 'utility-damage':
      return first(
        q(u?.utilityDamagePerRound, 'per-round'),
        q(team?.utility.utilityDamagePerRound, 'per-round'),
      );
    case 'flash-assists':
      return first(per100(u?.flashAssistsPerRound), per100(team?.utility.flashAssistsPerRound));
    case 'utility-kills':
      return per100(u?.utilityKillsPerRound);
    case 'flashes-thrown':
      return metric(
        u?.sample.rounds ? u.flashesThrown / u.sample.rounds : null,
        'per-round',
        u?.flashesThrown,
        u?.sample.rounds,
      );
    case 'enemy-blind-per-flash':
      return first(
        q(u?.enemyBlindSecondsPerFlash, 'seconds'),
        q(team?.utility.enemyBlindSecondsPerFlash, 'seconds'),
      );
    case 'enemy-blind-per-round':
      return first(
        q(u?.enemyBlindSecondsPerRound, 'seconds'),
        q(team?.utility.enemyBlindSecondsPerRound, 'seconds'),
      );
    case 'team-blind-per-round':
      return q(u?.teamBlindSecondsPerRound, 'seconds');
    case 'plant-conversion':
      return q(facts?.plantConversions, 'percent', 100);
    case 'eco-semi':
      return w(team?.economy.ecoSemiUpset);
    case 'comeback':
      return q(facts?.opening?.comebackRate, 'percent', 100);
    case 'awp-kills':
      return metric(
        awp?.kills ?? (knownMissingAwp ? 0 : null),
        'count',
        null,
        facts?.weaponsCoverage?.rounds,
      );
    case 'awp-per100':
      return awp
        ? per100(awp.killsPerRound)
        : metric(
            knownMissingAwp && facts?.weaponsCoverage?.rounds ? 0 : null,
            'per100',
            knownMissingAwp ? 0 : null,
            facts?.weaponsCoverage?.rounds,
          );
    case 'awp-share':
      return awp
        ? q(awp.killShare, 'percent', 100)
        : metric(
            knownMissingAwp && facts?.weaponsCoverage?.totalKills ? 0 : null,
            'percent',
            knownMissingAwp ? 0 : null,
            facts?.weaponsCoverage?.totalKills,
          );
    default:
      return empty();
  }
}
const keys: Partial<Record<Page['kind'], string[]>> = {
  overview: ['rating', 'round-win', 'ct', 't'],
  economy: ['pistol', 'pistol-conversion', 'pistol-break'],
  opening: ['opening', 'win-after-opening', 'trade', 'opening-death-traded'],
  advantage: ['5v4', '4v5', '5v3', '3v5'],
  utility: ['utility-damage', 'flash-assists', 'utility-kills', 'flashes-thrown'],
  flash: ['enemy-blind-per-flash', 'enemy-blind-per-round', 'team-blind-per-round'],
  conversion: ['plant-conversion', 'eco-semi', 'comeback'],
  awp: ['awp-kills', 'awp-per100', 'awp-share'],
};
function row(
  key: string,
  values: [Metric, Metric],
  positions: readonly number[],
): Page['metricRows'][number] | null {
  const present = positions.map((i) => values[i]!.value).filter((v): v is number => v !== null);
  if (!present.length) return null;
  const peak = Math.max(0, ...present);
  const magnitude = peak ? 10 ** Math.floor(Math.log10(peak)) : 1;
  const max =
    values[0].unit === 'percent'
      ? 100
      : peak
        ? (Math.ceil((peak / magnitude) * 2) / 2) * magnitude
        : 1;
  return { key, values, max };
}

export function preparePage(page: Page, histories: [Team, Team], players: Player[]): Page {
  const selected = page.playerIds
    .map((id) => players.find((p) => p.userId === id))
    .filter((p): p is Player => !!p);
  const teamRows = (keys[page.kind] ?? []).flatMap((key) => {
    const result = row(
      key,
      [teamMetric(histories[0], key), teamMetric(histories[1], key)],
      page.teamIndices,
    );
    return result ? [result] : [];
  });
  const playerKeys = ['rating', 'adr', 'kpr', 'kast', 'opening', 'trade'] as const;
  const playerRows =
    page.kind === 'players' && selected.length === 2
      ? playerKeys.flatMap((key) => {
          const result = row(key, [selected[0]!.metrics[key], selected[1]!.metrics[key]], [0, 1]);
          return result ? [result] : [];
        })
      : [];
  const clutchRows =
    page.kind === 'clutch' && selected.length === 2
      ? Array.from({ length: 6 }, (_, i) => {
          const result = row(
            `1v${i || 'x'}`,
            [
              selected[0]!.clutch[i]?.metric ?? empty('percent'),
              selected[1]!.clutch[i]?.metric ?? empty('percent'),
            ],
            [0, 1],
          );
          return result ? [result] : [];
        }).flat()
      : [];
  return {
    ...page,
    metricRows: [...teamRows, ...playerRows, ...clutchRows],
    maps: ['maps', 'maps-info', 'map-profile', 'veto'].includes(page.kind)
      ? mapsFor(page.mapNames, histories)
      : [],
    lineupHasStats: sides.map((side) =>
      selected.some(
        (p) =>
          p.teamIndex === side && (p.metrics.rating.value !== null || p.metrics.adr.value !== null),
      ),
    ) as [boolean, boolean],
    profileDefaultId: page.kind === 'profile' ? (page.playerIds[0] ?? null) : null,
    weapons: sides.map((side) =>
      page.kind === 'weapons' && page.teamIndices.includes(side)
        ? [...(histories[side]?.facts?.weapons ?? [])]
            .sort((a, b) => b.kills - a.kills || a.weapon.localeCompare(b.weapon))
            .slice(0, 5)
            .map((weapon) => ({
              weapon: weapon.weapon,
              kills: weapon.kills,
              share: q(weapon.killShare, 'percent', 100),
              per100: per100(weapon.killsPerRound),
            }))
        : [],
    ) as Page['weapons'],
    weaponCoverage: sides.map((side) => {
      const facts = histories[side]?.facts;
      if (!facts?.weapons) return null;
      return {
        completeness: facts.weaponsCoverage?.completeness ?? 'unknown',
        totalKills:
          facts.weaponsCoverage?.totalKills ?? facts.weapons[0]?.killShare.attempts ?? null,
        rounds: facts.weaponsCoverage?.rounds ?? facts.weapons[0]?.killsPerRound.attempts ?? null,
      };
    }) as Page['weaponCoverage'],
  };
}
