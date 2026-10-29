import type { BroadcastStats } from '@mizar/protocol/broadcast-stats';
import type { StatsInsert } from '@mizar/hud-view';

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
    scope: '本届 · 统计快照',
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
  const mapPageSize = 7;
  for (let start = 0; start < maps.length; start += mapPageSize) {
    const pages = Math.ceil(maps.length / mapPageSize);
    result.push({
      ...base,
      scope: pages > 1 ? `${base.scope} · ${start / mapPageSize + 1} / ${pages} 页` : base.scope,
      title: '地图表现',
      subtitle: 'MAP PERFORMANCE',
      rows: maps.slice(start, start + mapPageSize),
    });
  }
  if (
    a.recentResults.available &&
    b.recentResults.available &&
    a.recentResults.results.length &&
    b.recentResults.results.length
  ) {
    const recent = (team: Entrant) =>
      team.recentResults.results.slice(0, 5).map((item) => ({
        value: `${item.score}–${item.opponentScore} · ${item.opponent.name}`,
        sample: cleanMap(item.mapName),
        logo: item.opponent.logoUrl,
      }));
    result.push({
      ...base,
      scope: '本届 · 最近 5 图',
      title: '近期战绩',
      subtitle: 'RECENT MAPS',
      rows: [],
      recent: [recent(a), recent(b)],
    });
  }
  const winCard = (
    kind: 'pistol' | 'economy',
    fields: readonly { get: (entry: Entrant) => Entrant['pistol']['pistol']; label: string }[],
    title: string,
    subtitle: string,
  ) => {
    const l = a[kind],
      r = b[kind];
    if (!l.available || !r.available || l.scope !== r.scope) return;
    const rows = fields.flatMap(({ get, label }) => {
      const x = get(a),
        y = get(b);
      if (
        !x ||
        !y ||
        x.rate === null ||
        y.rate === null ||
        x.opportunities <= 0 ||
        y.opportunities <= 0 ||
        x.wins > x.opportunities ||
        y.wins > y.opportunities
      )
        return [];
      return [
        {
          label,
          values: [`${(x.rate * 100).toFixed(1)}%`, `${(y.rate * 100).toFixed(1)}%`] as const,
          samples: [`${x.wins} / ${x.opportunities}`, `${y.wins} / ${y.opportunities}`] as const,
        },
      ];
    });
    if (rows.length) result.push({ ...base, title, subtitle, layout: 'columns', rows });
  };
  winCard(
    'pistol',
    [
      { get: (e) => e.pistol.pistol, label: '手枪局' },
      { get: (e) => e.pistol.conversion, label: '赢手枪后的第二回合' },
      { get: (e) => e.pistol.break, label: '输手枪后的第二回合' },
    ],
    '手枪局与第二回合',
    'PISTOL & CONVERSION',
  );
  winCard(
    'economy',
    [{ get: (e) => e.economy.ecoSemiUpset, label: '经济劣势取胜' }],
    '经济局表现',
    'ECONOMY',
  );
  const utilityFields = [
    { key: 'utilityDamagePerRound', label: '道具伤害 / 回合' },
    { key: 'flashAssistsPerRound', label: '闪光助攻 / 回合' },
    { key: 'enemyBlindSecondsPerFlash', label: '敌方致盲秒数 / 颗' },
    { key: 'enemyBlindSecondsPerRound', label: '敌方致盲秒数 / 回合' },
  ] as const;
  if (a.utility.available && b.utility.available && a.utility.scope === b.utility.scope) {
    const rows = utilityFields.flatMap(({ key, label }) => {
      const x = a.utility[key],
        y = b.utility[key];
      if (!x || !y || x.rate === null || y.rate === null || x.attempts <= 0 || y.attempts <= 0)
        return [];
      return [
        {
          label,
          values: [x.rate.toFixed(2), y.rate.toFixed(2)] as const,
          samples: [
            `${x.attempts} ${key === 'enemyBlindSecondsPerFlash' ? '颗' : '回合'}`,
            `${y.attempts} ${key === 'enemyBlindSecondsPerFlash' ? '颗' : '回合'}`,
          ] as const,
        },
      ];
    });
    if (rows.length)
      result.push({ ...base, title: '道具支援', subtitle: 'UTILITY', layout: 'cells', rows });
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
  const focus = (team: Entrant): Player | undefined =>
    team.playerPerformance.players
      .filter(
        (player) =>
          team.starters.some((starter) => starter.userId === player.userId) &&
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
        ...(left.adr !== null &&
        right.adr !== null &&
        left.sample.adrRounds !== null &&
        left.sample.adrRounds > 0 &&
        right.sample.adrRounds !== null &&
        right.sample.adrRounds > 0
          ? [
              {
                label: 'ADR / 回合',
                values: [left.adr.toFixed(1), right.adr.toFixed(1)] as const,
                samples: [
                  `${left.sample.adrRounds} 回合`,
                  `${right.sample.adrRounds} 回合`,
                ] as const,
              },
            ]
          : []),
      ],
    });
  }
  const keys = Object.keys(labels);
  const values = (p: Player) =>
    keys.map((key) => p.attributes.values.find((item) => item.key === key));
  const portrait = (p: Player) =>
    p.attributes.available &&
    p.attributes.values.length === 7 &&
    new Set(p.attributes.values.map((item) => item.key)).size === 7 &&
    values(p).every((item) => item && item.score !== null && item.status === 'qualified');
  const lp = left,
    rp = right;
  if (
    lp &&
    rp &&
    portrait(lp) &&
    portrait(rp) &&
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
      scope: `本届 · 全站历史基准 · ${lp.attributes.sample.rounds} / ${rp.attributes.sample.rounds} 回合 · 0–100`,
      title: '选手画像',
      subtitle: 'PLAYER ATTRIBUTES',
      layout: 'radar',
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
