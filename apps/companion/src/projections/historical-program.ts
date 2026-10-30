import type { BroadcastStats } from '@mizar/protocol/broadcast-stats';
import {
  broadcastStatsProgramSchema,
  type BroadcastStatsProgram,
} from '@mizar/protocol/broadcast-stats-presentation';
import type { ProgramPresentation, ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { MatchContextBinding } from '../match-context/lkg-store.js';
import { bindHistoricalStats, hasRatingSample } from './historical-stats.js';
import { displayPlayers, preparePage } from './historical-program-display.js';

type Entrant = BroadcastStats['entrants'][number];
type Page = BroadcastStatsProgram['pages'][number];
const sides = [0, 1] as const;
const attributeKeys = [
  'firepower',
  'entrying',
  'trading',
  'opening',
  'clutching',
  'sniping',
  'utility',
] as const;
const rate = (value: { attempts: number; rate: number | null } | null | undefined) =>
  !!value && value.attempts > 0 && value.rate !== null;
const win = (
  value: { wins: number; opportunities: number; rate: number | null } | null | undefined,
) => !!value && value.opportunities > 0 && value.wins <= value.opportunities && value.rate !== null;
const page = (kind: Page['kind'], options: Partial<Omit<Page, 'kind'>> = {}): Page => ({
  id: kind,
  kind,
  teamIndices: [],
  playerIds: [],
  mapNames: [],
  recentIds: [[], []],
  recentItems: [[], []],
  vetoSteps: [],
  metricRows: [],
  maps: [],
  lineupHasStats: [false, false],
  profileDefaultId: null,
  ranks: [],
  totalItems: 0,
  weapons: [[], []],
  weaponCoverage: [null, null],
  pageNumber: 1,
  pageCount: 1,
  ...options,
});
const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};

/** Select website-owned historical facts alongside the active local match facts. */
export function projectHistoricalProgram(
  binding: MatchContextBinding,
  raw: BroadcastStats | null,
  program: ProgramPresentation | null,
  scene: ProgramSceneId,
): BroadcastStatsProgram {
  const context = binding.context;
  const candidate =
    raw?.matchId === context.matchId && context.competition?.competitionId === raw.competitionId
      ? bindHistoricalStats(raw, binding.manifest)
      : null;
  const bound =
    candidate &&
    candidate.entrants[0]?.entryId === context.entrants.a.entryId &&
    candidate.entrants[1]?.entryId === context.entrants.b.entryId
      ? candidate
      : null;
  const histories: [Entrant | null, Entrant | null] = [
    bound?.entrants[0] ?? null,
    bound?.entrants[1] ?? null,
  ];
  const teams = [context.entrants.a, context.entrants.b].map((team) => ({
    entryId: team.entryId,
    name: team.name,
    logoUrl: team.logoUrl,
    starters: team.players
      .filter((player) => player.isStarter)
      .map((player) => ({
        userId: player.playerId,
        nickname: player.displayName,
        avatarUrl: player.avatarUrl,
      })),
  })) as [BroadcastStatsProgram['teams'][0], BroadcastStatsProgram['teams'][1]];
  const local = program?.match?.matchId === context.matchId ? program : null;
  const pool = bound?.mapPool ?? context.mapPool ?? [];
  const pages: Page[] = [page('match', { teamIndices: [0, 1] })];
  if (local?.series?.maps.length) pages.push(page('series', { teamIndices: [0, 1] }));
  const summary =
    scene === 'halftime'
      ? local?.halftime
      : ['intermap', 'map_result', 'match_result'].includes(scene)
        ? local?.completed.at(-1)
        : null;
  if (summary?.score.a != null && summary.score.b != null)
    pages.push(page('current-map', { teamIndices: [0, 1] }));
  const vetoPages = chunks(
    [...(local?.series?.veto ?? [])].sort((a, b) => a.stepOrder - b.stepOrder),
    10,
  );
  vetoPages.forEach((items, i) =>
    pages.push(
      page('bp', {
        id: i ? `bp-${i + 1}` : 'bp',
        mapNames: items.map((item) => item.mapName),
        vetoSteps: items,
        pageNumber: i + 1,
        pageCount: vetoPages.length,
        teamIndices: [0, 1],
      }),
    ),
  );
  const rosterPages = Math.max(...teams.map((team) => Math.ceil(team.starters.length / 5)));
  for (let i = 0; i < rosterPages; i++)
    pages.push(
      page('lineup', {
        id: i ? `lineup-${i + 1}` : 'lineup',
        playerIds: teams.flatMap((team) =>
          team.starters.slice(i * 5, i * 5 + 5).map((player) => player.userId),
        ),
        teamIndices: sides.filter(
          (side) => teams[side].starters.slice(i * 5, i * 5 + 5).length > 0,
        ),
        pageNumber: i + 1,
        pageCount: rosterPages,
      }),
    );
  const mapSides = sides.filter(
    (i) =>
      histories[i]?.mapPerformance.available &&
      histories[i]!.mapPerformance.maps.some(
        (map) => map.played > 0 && map.winRate !== null && map.wins <= map.played,
      ),
  );
  const mapNames = [...pool];
  const mapPages = chunks(mapNames, 7);
  mapPages.forEach((items, i) =>
    pages.push(
      page(mapSides.length ? 'maps' : 'maps-info', {
        id: i ? `maps-${i + 1}` : 'maps',
        mapNames: items,
        teamIndices: mapSides.length ? mapSides : [0, 1],
        pageNumber: i + 1,
        pageCount: mapPages.length,
      }),
    ),
  );
  sides.forEach((side) => {
    const maps =
      histories[side]?.facts?.maps.filter((map) => map.results && map.results.played > 0) ?? [];
    const parts = chunks(maps, 3);
    parts.forEach((items, i) =>
      pages.push(
        page('map-profile', {
          id: `maps-${side === 0 ? 'a' : 'b'}-${i + 1}`,
          teamIndices: [side],
          mapNames: items.map((map) => map.mapName),
          pageNumber: i + 1,
          pageCount: parts.length,
        }),
      ),
    );
  });
  const vetoSides = sides.filter(
    (i) =>
      (histories[i]?.facts?.results?.matches ?? 0) > 0 &&
      histories[i]?.facts?.maps.some(
        (map) =>
          map.selection &&
          (map.selection.picks > 0 || map.selection.bans > 0 || map.selection.deciders > 0),
      ),
  );
  if (vetoSides.length)
    chunks(pool, 7).forEach((items, i, all) =>
      pages.push(
        page('veto', {
          id: i ? `veto-${i + 1}` : 'veto',
          teamIndices: vetoSides,
          mapNames: items,
          pageNumber: i + 1,
          pageCount: all.length,
        }),
      ),
    );
  const recents = histories.map((team) =>
    team?.facts
      ? team.facts.series.matches.map((value) => ({ kind: 'series' as const, value }))
      : team?.recentResults.available
        ? team.recentResults.results.map((value) => ({ kind: 'map' as const, value }))
        : [],
  );
  const recentPages = Math.max(...recents.map((items) => Math.ceil(items.length / 2)));
  for (let i = 0; i < recentPages; i++) {
    const items = [recents[0]!.slice(i * 2, i * 2 + 2), recents[1]!.slice(i * 2, i * 2 + 2)] as [
      (typeof recents)[number],
      (typeof recents)[number],
    ];
    pages.push(
      page('recent', {
        id: i ? `recent-${i + 1}` : 'recent',
        teamIndices: sides.filter((side) => items[side].length > 0),
        recentIds: [
          items[0].map((item) => item.value.matchId),
          items[1].map((item) => item.value.matchId),
        ],
        recentItems: items,
        pageNumber: i + 1,
        pageCount: recentPages,
      }),
    );
  }
  const candidates = sides.map((side) => {
    const roster = new Set(teams[side].starters.map((player) => player.userId));
    return (histories[side]?.playerPerformance.players ?? [])
      .filter((player) => roster.has(player.userId) && hasRatingSample(player))
      .sort(
        (a, b) => b.rating! - a.rating! || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
      );
  });
  const left = candidates[0]![0],
    right = candidates[1]![0];
  const selected = left && right ? ([left.userId, right.userId] as [string, string]) : null;
  if (selected) pages.push(page('players', { teamIndices: [0, 1], playerIds: selected }));
  const radarValues =
    left &&
    right &&
    left.attributes.benchmark === right.attributes.benchmark &&
    left.attributes.scope === right.attributes.scope
      ? attributeKeys.map((key) => ({
          key,
          values: [
            left.attributes.values.find((value) => value.key === key)?.score ?? null,
            right.attributes.values.find((value) => value.key === key)?.score ?? null,
          ] as [number | null, number | null],
        }))
      : null;
  const radar =
    radarValues && sides.every((side) => radarValues.some((value) => value.values[side] !== null))
      ? {
          mode: radarValues.every((value) => value.values.every((number) => number !== null))
            ? ('radar' as const)
            : ('bars' as const),
          values: radarValues,
          visibleKeys: radarValues
            .filter((value) => value.values.some((number) => number !== null))
            .map((value) => value.key),
        }
      : null;
  if (radar && selected) pages.push(page('radar', { teamIndices: [0, 1], playerIds: selected }));
  const allPlayers = teams.flatMap((team) => team.starters.map((player) => player.userId));
  const displays = displayPlayers(teams, histories);
  if (allPlayers.length)
    pages.push(
      page('profile', {
        teamIndices: sides.filter((side) => teams[side].starters.length > 0),
        playerIds: allPlayers,
      }),
    );
  const ranked = candidates
    .flat()
    .sort(
      (a, b) => b.rating! - a.rating! || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
  if (ranked.length >= 2)
    chunks(ranked, 10).forEach((items, i, all) =>
      pages.push(
        page('ranking', {
          id: i ? `ranking-${i + 1}` : 'ranking',
          playerIds: items.map((player) => player.userId),
          ranks: items.map((player, index) => ({
            userId: player.userId,
            place: i * 10 + index + 1,
          })),
          totalItems: ranked.length,
          teamIndices: [0, 1],
          pageNumber: i + 1,
          pageCount: all.length,
        }),
      ),
    );
  const multiRanked = displays
    .filter((player) => (player.maps ?? 0) > 0 && player.metrics.multikill.value !== null)
    .sort(
      (a, b) =>
        b.metrics.multikill.value! - a.metrics.multikill.value! ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
  if (multiRanked.length >= 2)
    chunks(multiRanked, 10).forEach((items, i, all) =>
      pages.push(
        page('multikill', {
          id: i ? `multikill-${i + 1}` : 'multikill',
          playerIds: items.map((player) => player.userId),
          ranks: items.map((player, index) => ({
            userId: player.userId,
            place: i * 10 + index + 1,
          })),
          totalItems: multiRanked.length,
          teamIndices: sides.filter((side) =>
            items.some((player) =>
              teams[side].starters.some((starter) => starter.userId === player.userId),
            ),
          ),
          pageNumber: i + 1,
          pageCount: all.length,
        }),
      ),
    );
  const specs: Array<[Page['kind'], (team: Entrant) => boolean]> = [
    ['overview', (team) => (team.facts?.rounds?.rounds ?? 0) > 0],
    ['economy', (team) => win(team.pistol.pistol)],
    [
      'opening',
      (team) =>
        !!team.facts?.opening &&
        (rate(team.facts.opening.successRate) || rate(team.facts.opening.tradeKillsPerRound)),
    ],
    [
      'advantage',
      (team) => !!team.facts?.manAdvantage && Object.values(team.facts.manAdvantage).some(win),
    ],
    [
      'utility',
      (team) =>
        (!!team.facts?.utility &&
          (rate(team.facts.utility.utilityDamagePerRound) ||
            rate(team.facts.utility.flashAssistsPerRound) ||
            rate(team.facts.utility.utilityKillsPerRound) ||
            team.facts.utility.sample.rounds > 0)) ||
        (team.utility.available &&
          (rate(team.utility.utilityDamagePerRound) || rate(team.utility.flashAssistsPerRound))),
    ],
    [
      'flash',
      (team) =>
        (!!team.facts?.utility &&
          (rate(team.facts.utility.enemyBlindSecondsPerFlash) ||
            rate(team.facts.utility.enemyBlindSecondsPerRound) ||
            rate(team.facts.utility.teamBlindSecondsPerRound))) ||
        (team.utility.available &&
          (rate(team.utility.enemyBlindSecondsPerFlash) ||
            rate(team.utility.enemyBlindSecondsPerRound))),
    ],
    ['weapons', (team) => !!team.facts?.weapons?.some((weapon) => weapon.killShare.attempts > 0)],
    [
      'awp',
      (team) =>
        !!team.facts?.weapons?.some(
          (weapon) =>
            weapon.weapon.toUpperCase() === 'AWP' &&
            (rate(weapon.killsPerRound) || rate(weapon.killShare)),
        ) ||
        (team.facts?.weaponsCoverage?.completeness === 'complete' &&
          team.facts.weapons !== null &&
          team.facts.weaponsCoverage.rounds > 0),
    ],
    [
      'conversion',
      (team) =>
        rate(team.facts?.plantConversions) ||
        win(team.economy.ecoSemiUpset) ||
        rate(team.facts?.opening?.comebackRate),
    ],
  ];
  for (const [kind, eligible] of specs) {
    const teamIndices = sides.filter((i) => histories[i] !== null && eligible(histories[i]!));
    if (teamIndices.length) pages.push(page(kind, { teamIndices }));
  }
  if (selected) {
    const clutch = sides.map(
      (i) =>
        histories[i]?.facts?.players.find((player) => player.userId === selected[i])?.detailed
          ?.clutch,
    );
    if (clutch.every(Boolean) && clutch.some((item) => item && rate(item.winRate)))
      pages.push(page('clutch', { teamIndices: [0, 1], playerIds: selected }));
  }
  const support = bound?.support ?? null;
  const supportSides = teams.map(
    (team) => support?.sides.find((side) => side.entryId === team.entryId)?.ratio ?? null,
  ) as [number | null, number | null];
  if (
    support &&
    /[1-9]/.test(support.total) &&
    teams.every((team) =>
      support.sides.some((side) => side.entryId === team.entryId && side.ratio !== null),
    )
  )
    pages.push(page('community', { teamIndices: [0, 1] }));
  if (scene === 'halftime' || scene === 'intermap') {
    const order: Partial<Record<Page['kind'], number>> = { 'current-map': 0, series: 1, match: 2 };
    pages.sort((a, b) => (order[a.kind] ?? 5) - (order[b.kind] ?? 5));
  }
  return broadcastStatsProgramSchema.parse({
    schemaVersion: 'mizar.broadcast-stats-program.v1',
    matchId: context.matchId,
    competitionId: context.competition?.competitionId ?? null,
    sourceRevision: bound?.revision ?? null,
    sourceGeneratedAt: bound?.generatedAt ?? null,
    phase:
      scene === 'bp'
        ? 'bp'
        : scene === 'halftime'
          ? 'halftime'
          : scene === 'match_result'
            ? 'postmatch'
            : scene === 'map_result' || scene === 'intermap'
              ? 'intermap'
              : scene === 'gameplay'
                ? 'live'
                : 'prematch',
    teams,
    displayPlayers: displays,
    records: histories.map((entry) => ({
      series: entry?.facts?.results
        ? { wins: entry.facts.results.matchWins, losses: entry.facts.results.matchLosses }
        : null,
      maps: entry?.facts?.results
        ? { wins: entry.facts.results.mapWins, losses: entry.facts.results.mapLosses }
        : null,
      rounds: entry?.facts?.rounds?.rounds ?? null,
    })),
    matchScore:
      (scene === 'intermap' || scene === 'map_result' || scene === 'match_result') && local?.series
        ? local.series.score
        : null,
    communityDisplay: support
      ? {
          total: support.total,
          percentages: supportSides.map((value) => (value === null ? null : value * 100)),
        }
      : null,
    history: histories,
    mapPool: pool,
    support,
    program: local,
    selectedPlayerIds: selected,
    radar,
    selectedMap: summary ?? null,
    summaryHasKAD:
      !!summary &&
      [...summary.players.a, ...summary.players.b].some(
        (player) => player.kills !== null || player.assists !== null || player.deaths !== null,
      ),
    pages: pages.map((item) => preparePage(item, histories, displays)),
  });
}
