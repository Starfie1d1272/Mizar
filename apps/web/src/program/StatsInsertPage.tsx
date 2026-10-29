import { useEffect, useState } from 'react';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import { StatsInsertView, type StatsInsert } from '@mizar/hud-view';

type Entrant = BroadcastStats['entrants'][number];
type Player = Entrant['playerPerformance']['players'][number];
const labels: Record<string, string> = {
  firepower: '火力',
  entrying: '突破',
  trading: '补枪',
  opening: '首杀',
  clutching: '残局',
  sniping: '狙击',
  utility: '道具',
};
const cleanMap = (value: string) => value.replace(/^de_/, '').toUpperCase();

/** Select only complete comparisons. Statistics remain website-owned values. */
export function statsInserts(bundle: BroadcastStats): StatsInsert[] {
  const [a, b] = bundle.entrants;
  if (!a || !b || a.entryId === b.entryId) return [];
  const base = {
    scope: '本届 · 赛前',
    teams: [a.name, b.name] as const,
    logos: [a.logoUrl, b.logoUrl] as const,
  };
  const result: StatsInsert[] = [];
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
        label: cleanMap(left.mapName),
        artwork: left.mapName,
        values: [
          `${(left.winRate * 100).toFixed(1)}%`,
          `${(right.winRate * 100).toFixed(1)}%`,
        ] as const,
        samples: [`${left.played} 图`, `${right.played} 图`] as const,
      },
    ];
  });
  if (
    maps.length > 0 &&
    maps.length <= 7 &&
    maps.length === a.mapPerformance.maps.length &&
    maps.length === b.mapPerformance.maps.length &&
    new Set(a.mapPerformance.maps.map((map) => map.mapName)).size === maps.length &&
    new Set(b.mapPerformance.maps.map((map) => map.mapName)).size === maps.length
  )
    result.push({
      ...base,
      title: '地图表现',
      subtitle: 'MAP PERFORMANCE',
      rows: maps.slice(0, 7),
    });
  if (
    a.recentResults.available &&
    b.recentResults.available &&
    a.recentResults.results.length &&
    a.recentResults.results.length === b.recentResults.results.length
  ) {
    const n = Math.min(a.recentResults.results.length, b.recentResults.results.length, 5);
    result.push({
      ...base,
      scope: `本届 · 赛前 · 最近 ${n} 图`,
      title: '近期战绩',
      subtitle: 'RECENT MAPS',
      rows: Array.from({ length: n }, (_, i) => {
        const left = a.recentResults.results[i]!,
          right = b.recentResults.results[i]!;
        return {
          label: `第 ${i + 1} 图`,
          values: [
            `${left.score}–${left.opponentScore} · ${left.opponent.name}`,
            `${right.score}–${right.opponentScore} · ${right.opponent.name}`,
          ] as const,
          samples: [cleanMap(left.mapName), cleanMap(right.mapName)] as const,
        };
      }),
    });
  }
  if (
    a.starters.length === 5 &&
    b.starters.length === 5 &&
    new Set(a.starters.map((player) => player.userId)).size === 5 &&
    new Set(b.starters.map((player) => player.userId)).size === 5
  ) {
    result.push({
      ...base,
      title: '本场阵容',
      subtitle: 'LINEUPS',
      rows: a.starters.map((player, i) => ({
        label: String(i + 1).padStart(2, '0'),
        values: [player.nickname, b.starters[i]!.nickname] as const,
        portraits: [player.avatarUrl, b.starters[i]!.avatarUrl] as const,
      })),
    });
  }
  const covered = (team: Entrant) =>
    team.playerPerformance.available &&
    team.starters.length === 5 &&
    team.starters.every((starter) =>
      team.playerPerformance.players.some(
        (p) => p.userId === starter.userId && p.rating !== null && p.adr !== null,
      ),
    );
  const focus = (team: Entrant): Player | undefined =>
    covered(a) && covered(b) && team.playerPerformance.available
      ? team.playerPerformance.players.find(
          (player) =>
            team.starters.some((starter) => starter.userId === player.userId) &&
            player.sample.maps > 0 &&
            player.sample.ratingMaps > 0 &&
            player.rating !== null &&
            player.adr !== null,
        )
      : undefined;
  const left = focus(a),
    right = focus(b);
  if (left && right) {
    const playerName = (team: Entrant, player: Player) =>
      team.starters.find((starter) => starter.userId === player.userId)!.nickname;
    const playerBase = {
      ...base,
      teams: [playerName(a, left), playerName(b, right)] as const,
      logos: [
        a.starters.find((p) => p.userId === left.userId)!.avatarUrl,
        b.starters.find((p) => p.userId === right.userId)!.avatarUrl,
      ] as const,
    };
    const sample = [left, right].map((p) =>
      [`${p.sample.maps} 图`, p.sample.adrRounds === null ? null : `${p.sample.adrRounds} 回合`]
        .filter(Boolean)
        .join(' · '),
    ) as [string, string];
    result.push({
      ...playerBase,
      title: '选手对比',
      subtitle: 'PLAYER COMPARISON',
      rows: [
        {
          label: 'Rating',
          values: [left.rating!.toFixed(2), right.rating!.toFixed(2)],
          samples: [`${left.sample.ratingMaps} 图`, `${right.sample.ratingMaps} 图`],
        },
        {
          label: 'ADR / 回合',
          values: [left.adr!.toFixed(1), right.adr!.toFixed(1)],
          samples: sample,
        },
      ],
    });
  }
  const keys = Object.keys(labels);
  const values = (p: Player) =>
    keys.map((key) => p.attributes.values.find((item) => item.key === key));
  const portrait = (team: Entrant) =>
    team.playerPerformance.available
      ? team.playerPerformance.players.find(
          (p) =>
            team.starters.some((starter) => starter.userId === p.userId) &&
            p.attributes.available &&
            p.attributes.values.length === 7 &&
            new Set(p.attributes.values.map((item) => item.key)).size === 7 &&
            values(p).every((item) => item && item.score !== null && item.status === 'qualified'),
        )
      : undefined;
  const lp = portrait(a),
    rp = portrait(b);
  if (
    lp &&
    rp &&
    lp.attributes.benchmark === rp.attributes.benchmark &&
    lp.attributes.scope === rp.attributes.scope
  ) {
    const lv = values(lp),
      rv = values(rp);
    const ls = a.starters.find((starter) => starter.userId === lp.userId)!;
    const rs = b.starters.find((starter) => starter.userId === rp.userId)!;
    result.push({
      ...base,
      teams: [ls.nickname, rs.nickname],
      logos: [ls.avatarUrl, rs.avatarUrl],
      scope: '本届 · 赛前 · 全站历史基准 · 0–100',
      title: '选手画像',
      subtitle: 'PLAYER ATTRIBUTES',
      rows: keys.map((key, i) => ({
        label: labels[key]!,
        values: [String(lv[i]!.score), String(rv[i]!.score)] as const,
        samples: [
          `${lp.attributes.sample.rounds} 回合`,
          `${rp.attributes.sample.rounds} 回合`,
        ] as const,
      })),
    });
  }
  return result;
}

export function StatsInsertPage() {
  const [bundle, setBundle] = useState<BroadcastStats | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/local/v1/broadcast-stats', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const parsed = broadcastStatsSchema.safeParse(data);
        if (active && parsed.success) setBundle(parsed.data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!bundle) return null;
  const cards = statsInserts(bundle);
  const requested = new URLSearchParams(window.location.search).get('card');
  const card = requested ? cards.find((item) => item.subtitle === requested) : cards[0];
  return card ? <StatsInsertView insert={card} /> : null;
}
