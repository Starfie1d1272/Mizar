import type { BroadcastStatsPresentation } from '@mizar/protocol/broadcast-stats-presentation';
import type { StatsInsert } from '@mizar/hud-view';

export type StatsCard = StatsInsert & {
  readonly id: BroadcastStatsPresentation[
    | 'maps'
    | 'recent'
    | 'pistol'
    | 'economy'
    | 'utility'
    | 'lineups'
    | 'playerComparison'
    | 'playerAttributes']['id'];
};
const labels = {
  firepower: '火力',
  entrying: '突破',
  trading: '补枪',
  opening: '首杀',
  clutching: '残局',
  sniping: '狙击',
  utility: '道具',
} as const;
const cleanMap = (value: string) => value.replace(/^de_/, '').toUpperCase();

/** Format and lay out the already selected local projection. */
export function statsInserts(bundle: BroadcastStatsPresentation): StatsCard[] {
  const [a, b] = bundle.teams;
  const base = {
    scope: '本届 · 统计快照',
    teams: [a.name, b.name] as const,
    logos: [a.logoUrl, b.logoUrl] as const,
  };
  const result: StatsCard[] = [];
  if (bundle.maps.eligible)
    for (const page of bundle.maps.pages) {
      result.push({
        ...base,
        id: bundle.maps.id,
        scope:
          bundle.maps.pages.length > 1
            ? `${base.scope} · ${page.page} / ${bundle.maps.pages.length} 页`
            : base.scope,
        title: '地图表现',
        subtitle: 'MAP PERFORMANCE',
        rows: page.rows.map((row) => ({
          label: cleanMap(row.mapName),
          artwork: row.mapName,
          values: [
            `${(row.values[0].winRate * 100).toFixed(1)}%`,
            `${(row.values[1].winRate * 100).toFixed(1)}%`,
          ] as const,
          samples: [`${row.values[0].played} 图`, `${row.values[1].played} 图`] as const,
        })),
      });
    }
  if (bundle.recent.eligible) {
    const format = (items: (typeof bundle.recent.results)[0]) =>
      items.map((item) => ({
        value: `${item.score}–${item.opponentScore} · ${item.opponent.name}`,
        sample: cleanMap(item.mapName),
        logo: item.opponent.logoUrl,
      }));
    result.push({
      ...base,
      id: bundle.recent.id,
      scope: '本届 · 最近 5 图',
      title: '近期战绩',
      subtitle: 'RECENT MAPS',
      rows: [],
      recent: [format(bundle.recent.results[0]), format(bundle.recent.results[1])],
    });
  }
  const winRows = (
    fields: readonly { label: string; values: typeof bundle.economy.ecoSemiUpset }[],
  ) =>
    fields.flatMap(({ label, values }) =>
      values
        ? [
            {
              label,
              values: [
                `${(values[0].rate * 100).toFixed(1)}%`,
                `${(values[1].rate * 100).toFixed(1)}%`,
              ] as const,
              samples: [
                `${values[0].wins} / ${values[0].opportunities}`,
                `${values[1].wins} / ${values[1].opportunities}`,
              ] as const,
            },
          ]
        : [],
    );
  if (bundle.pistol.eligible)
    result.push({
      ...base,
      id: bundle.pistol.id,
      title: '手枪局与第二回合',
      subtitle: 'PISTOL & CONVERSION',
      layout: 'columns',
      rows: winRows([
        { label: '手枪局', values: bundle.pistol.pistol },
        { label: '赢手枪后的第二回合', values: bundle.pistol.conversion },
        { label: '输手枪后的第二回合', values: bundle.pistol.break },
      ]),
    });
  if (bundle.economy.eligible)
    result.push({
      ...base,
      id: bundle.economy.id,
      title: '经济局表现',
      subtitle: 'ECONOMY',
      layout: 'columns',
      rows: winRows([{ label: '经济劣势取胜', values: bundle.economy.ecoSemiUpset }]),
    });
  if (bundle.utility.eligible) {
    const fields = [
      { label: '道具伤害 / 回合', values: bundle.utility.utilityDamagePerRound, unit: '回合' },
      { label: '闪光助攻 / 回合', values: bundle.utility.flashAssistsPerRound, unit: '回合' },
      { label: '敌方致盲秒数 / 颗', values: bundle.utility.enemyBlindSecondsPerFlash, unit: '颗' },
      {
        label: '敌方致盲秒数 / 回合',
        values: bundle.utility.enemyBlindSecondsPerRound,
        unit: '回合',
      },
    ];
    result.push({
      ...base,
      id: bundle.utility.id,
      title: '道具支援',
      subtitle: 'UTILITY',
      layout: 'cells',
      rows: fields.flatMap(({ label, values, unit }) =>
        values
          ? [
              {
                label,
                values: [values[0].rate.toFixed(2), values[1].rate.toFixed(2)] as const,
                samples: [
                  `${values[0].attempts} ${unit}`,
                  `${values[1].attempts} ${unit}`,
                ] as const,
              },
            ]
          : [],
      ),
    });
  }
  if (bundle.lineups.eligible)
    result.push({
      ...base,
      id: bundle.lineups.id,
      title: '本场阵容',
      subtitle: 'LINEUPS',
      rows: bundle.lineups.rows.map(([left, right], i) => ({
        label: String(i + 1).padStart(2, '0'),
        values: [left.nickname, right.nickname],
        portraits: [left.avatarUrl, right.avatarUrl],
      })),
    });
  const selected = bundle.selectedPlayers;
  if (bundle.playerComparison.eligible && selected && bundle.playerComparison.rating) {
    const [left, right] = bundle.playerComparison.rating;
    const adr = bundle.playerComparison.adr;
    result.push({
      ...base,
      id: bundle.playerComparison.id,
      teams: [selected[0].nickname, selected[1].nickname],
      logos: [selected[0].avatarUrl, selected[1].avatarUrl],
      title: '选手对比',
      subtitle: 'PLAYER COMPARISON',
      rows: [
        {
          label: 'Rating',
          values: [left.value.toFixed(2), right.value.toFixed(2)],
          samples: [`${left.sampleMaps} 图`, `${right.sampleMaps} 图`],
        },
        ...(adr
          ? [
              {
                label: 'ADR / 回合',
                values: [adr[0].value.toFixed(1), adr[1].value.toFixed(1)] as const,
                samples: [`${adr[0].sampleRounds} 回合`, `${adr[1].sampleRounds} 回合`] as const,
              },
            ]
          : []),
      ],
    });
  }
  const attributes = bundle.playerAttributes;
  if (attributes.eligible && selected && attributes.values && attributes.sampleRounds) {
    const rounds = attributes.sampleRounds;
    const values = attributes.values;
    result.push({
      ...base,
      id: attributes.id,
      teams: [selected[0].nickname, selected[1].nickname],
      logos: [selected[0].avatarUrl, selected[1].avatarUrl],
      scope: `本届 · 全站历史基准 · ${rounds[0]} / ${rounds[1]} 回合 · 0–100`,
      title: '选手画像',
      subtitle: 'PLAYER ATTRIBUTES',
      layout: 'radar',
      rows: (Object.keys(labels) as Array<keyof typeof labels>).map((key) => ({
        label: labels[key],
        values: [String(values[key][0]), String(values[key][1])],
        numericValues: values[key],
        samples: [`${rounds[0]} 回合`, `${rounds[1]} 回合`],
      })),
    });
  }
  return result;
}
