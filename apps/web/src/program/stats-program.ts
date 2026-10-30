import type { BroadcastStatsProgram } from '@mizar/protocol/broadcast-stats-presentation';
import type { StatsInsert } from '@mizar/hud-view';

type Page = BroadcastStatsProgram['pages'][number];
type Player = BroadcastStatsProgram['displayPlayers'][number];
type Metric = Player['metrics']['rating'];
type Content = NonNullable<StatsInsert['content']>;
const sides = [0, 1] as const;
const labels: Record<string, string> = {
  rating: 'Rating',
  adr: 'ADR',
  kpr: 'KPR',
  kast: 'KAST',
  opening: '首杀成功率',
  trade: '补枪',
  'round-win': '回合胜率',
  ct: 'CT 回合胜率',
  t: 'T 回合胜率',
  pistol: '手枪局',
  'pistol-conversion': '赢手枪后的第二回合',
  'pistol-break': '输手枪后的第二回合',
  'win-after-opening': '首杀后赢下回合',
  'opening-death-traded': '首死后被补枪',
  '5v4': '5v4 优势兑现',
  '4v5': '4v5 逆转获胜',
  '5v3': '5v3 优势兑现',
  '3v5': '3v5 逆转获胜',
  'utility-damage': '道具伤害 / 回合',
  'flash-assists': '闪光助攻 / 100 回合',
  'utility-kills': '道具击杀 / 100 回合',
  'flashes-thrown': '闪光投掷 / 回合',
  'enemy-blind-per-flash': '每颗闪光敌方致盲',
  'enemy-blind-per-round': '每回合敌方致盲',
  'team-blind-per-round': '每回合友军致盲',
  'awp-kills': 'AWP 击杀',
  'awp-per100': 'AWP 击杀',
  'awp-share': 'AWP 击杀占比',
  'plant-conversion': '下包后获胜率',
  'eco-semi': '低经济获胜率',
  comeback: '首死后逆转率',
  '1vx': '全部 1vX',
  '1v1': '1v1',
  '1v2': '1v2',
  '1v3': '1v3',
  '1v4': '1v4',
  '1v5': '1v5',
};
const attrLabels: Record<string, string> = {
  firepower: '火力',
  entrying: '突破',
  trading: '补枪',
  opening: '开局交火',
  clutching: '残局',
  sniping: '狙击',
  utility: '道具',
};
const titles: Record<Page['kind'], readonly [string, string]> = {
  match: ['对阵', 'MATCH'],
  'current-map': ['单图结果', 'MAP RESULT'],
  series: ['系列赛', 'SERIES'],
  bp: ['本场选禁', 'MAP VETO'],
  lineup: ['本场阵容', 'LINEUPS'],
  maps: ['地图表现', 'MAP POOL'],
  'maps-info': ['赛事地图池', 'MAP POOL'],
  'map-profile': ['地图档案', 'MAP PROFILE'],
  veto: ['历史选禁', 'PICK / BAN'],
  recent: ['近期战绩', 'RECENT RESULTS'],
  players: ['选手对比', 'PLAYER COMPARISON'],
  radar: ['打法画像', 'PLAYER ATTRIBUTES'],
  profile: ['选手介绍', 'PLAYER SHOWCASE'],
  ranking: ['阵容排行', 'LINEUP LEADERBOARD'],
  multikill: ['多杀与残局', 'MULTIKILL & CLUTCH'],
  overview: ['队伍表现', 'TEAM OVERVIEW'],
  economy: ['手枪局与第二回合', 'PISTOL & CONVERSION'],
  opening: ['首杀与补枪', 'OPENING & TRADING'],
  advantage: ['人数优势与逆转', 'ADVANTAGE & COMEBACK'],
  utility: ['道具支援', 'UTILITY'],
  flash: ['闪光效果', 'FLASH OUTPUT'],
  weapons: ['武器构成', 'WEAPON PROFILE'],
  awp: ['AWP 击杀', 'AWP IMPACT'],
  conversion: ['回合兑现', 'ROUND CONVERSION'],
  clutch: ['残局记录', 'CLUTCH'],
  community: ['观众支持', 'COMMUNITY SUPPORT'],
};
const phaseNames: Record<BroadcastStatsProgram['phase'], readonly [string, string]> = {
  prematch: ['赛前', 'PRE-MATCH'],
  bp: ['BP', 'MAP VETO'],
  live: ['比赛中', 'LIVE'],
  halftime: ['半场', 'HALFTIME'],
  intermap: ['图间', 'BETWEEN MAPS'],
  postmatch: ['赛后', 'POST-MATCH'],
};
const mapName = (value: string) => value.replace(/^de_/i, '').toUpperCase();
const number = (value: number | null | undefined, digits = 0) =>
  value == null ? '—' : value.toFixed(digits);
const metric = (value: Metric, key = '') => {
  const digits =
    value.unit === 'count'
      ? 0
      : [
            'rating',
            'kd',
            'kpr',
            'utility-damage',
            'flash-assists',
            'utility-kills',
            'flashes-thrown',
            'enemy-blind-per-flash',
            'enemy-blind-per-round',
            'team-blind-per-round',
          ].includes(key)
        ? 2
        : 1;
  return value.value == null
    ? '—'
    : `${value.value.toFixed(digits)}${value.unit === 'percent' ? '%' : ''}`;
};
const fraction = (value: Metric) =>
  value.denominator == null
    ? ''
    : value.denominator === 0
      ? '0 次机会'
      : value.numerator == null
        ? ''
        : `${value.numerator} / ${value.denominator}`;
const metricSample = (key: string, value: Metric) => {
  const units: Record<string, string> = {
    'utility-damage': '总伤害',
    'flash-assists': '次',
    'utility-kills': '次',
    'flashes-thrown': '颗',
    trade: '次',
  };
  if (key === 'rating' && value.denominator != null) return `${number(value.denominator)} 样本`;
  if (key === 'awp-kills' && value.denominator != null) return `${number(value.denominator)} 回合`;
  const unit = units[key];
  return unit && value.numerator != null ? `${number(value.numerator)} ${unit}` : fraction(value);
};
const metricUnits: Record<string, string> = {
  trade: '/ 100 回合',
  'enemy-blind-per-flash': '秒 / 颗',
  'enemy-blind-per-round': '秒 / 回合',
  'team-blind-per-round': '秒 / 回合',
  'awp-per100': '/ 100 回合',
  'eco-semi': 'Eco / Semi',
};
const sample = (p: Player) =>
  [
    p.maps != null && p.maps > 0 ? `${p.maps} 图` : '',
    p.rounds != null && p.rounds > 0 ? `${p.rounds} 回合` : '',
  ]
    .filter(Boolean)
    .join(' · ');
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value))
    : '';
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '';
const record = (value: { wins: number; losses: number } | null) =>
  value ? `${value.wins}–${value.losses}` : null;
const width = (value: number | null, max: number) =>
  value == null ? null : Math.max(0, Math.min(100, (value / max) * 100));

/** Format Companion's ordered, qualified pages; never read history or select statistics here. */
export function statsProgramInserts(
  bundle: BroadcastStatsProgram,
  profilePlayerId?: string | null,
): (StatsInsert & { readonly id: string })[] {
  const names = [bundle.teams[0].name, bundle.teams[1].name] as const;
  const logos = [bundle.teams[0].logoUrl, bundle.teams[1].logoUrl] as const;
  const players = new Map(bundle.displayPlayers.map((p) => [p.userId, p]));
  const find = (id: string) => players.get(id);
  const playerName = (p: Player | undefined) => p?.nickname || '—';
  const byPage = (page: Page) =>
    page.playerIds.map(find).filter((p): p is Player => p !== undefined);
  const mapPhoto = (name: string) => ({ name: mapName(name), artwork: name });
  return bundle.pages.map((page) => {
    const [defaultTitle, subtitle] = titles[page.kind];
    const visible = page.teamIndices;
    const topicPrefix =
      visible.length === 1 &&
      ![
        'match',
        'current-map',
        'series',
        'bp',
        'maps-info',
        'profile',
        'ranking',
        'multikill',
      ].includes(page.kind)
        ? `${names[visible[0]!]} · `
        : '';
    const title =
      page.kind === 'current-map' && bundle.phase === 'halftime'
        ? '半场表现'
        : `${topicPrefix}${defaultTitle}`;
    const chosen = byPage(page);
    const base: StatsInsert & { id: string } = {
      id: page.id,
      title,
      subtitle: page.kind === 'current-map' && bundle.phase === 'halftime' ? 'HALFTIME' : subtitle,
      scope: [bundle.competitionId ? '本届' : '', phaseNames[bundle.phase][0]]
        .filter(Boolean)
        .join(' · '),
      teams: names,
      logos,
      matchTeams: names,
      matchLogos: logos,
      visibleSides: visible,
      rows: [],
      phaseFormat: [phaseNames[bundle.phase][1], bundle.program?.match?.format.toUpperCase()]
        .filter(Boolean)
        .join(' · '),
      ...(bundle.program?.match?.competition?.name
        ? { event: bundle.program.match.competition.name }
        : {}),
      ...(bundle.program?.match?.stage ? { stage: bundle.program.match.stage } : {}),
      ...(page.pageCount > 1 ? { pageCount: `${page.pageNumber} / ${page.pageCount}` } : {}),
    };
    const selected = chosen.slice(0, 2);
    const pNames = [playerName(selected[0]), playerName(selected[1])] as const;
    const pAvatars = [selected[0]?.avatarUrl ?? null, selected[1]?.avatarUrl ?? null] as const;
    const playerTeams = [
      names[selected[0]?.teamIndex ?? 0],
      names[selected[1]?.teamIndex ?? 1],
    ] as const;
    const metricRows = page.metricRows.map((row) => ({
      label:
        page.kind === 'players' && row.key === 'opening'
          ? '首杀成功'
          : page.kind === 'players' && row.key === 'trade'
            ? '补枪 / 100 回合'
            : (labels[row.key] ?? row.key),
      ...(metricUnits[row.key] ? { unit: metricUnits[row.key] } : {}),
      values: [metric(row.values[0], row.key), metric(row.values[1], row.key)] as const,
      numericValues: [row.values[0].value, row.values[1].value] as const,
      barWidths: [
        width(row.values[0].value, row.max),
        width(row.values[1].value, row.max),
      ] as const,
      samples: [
        metricSample(row.key, row.values[0]),
        metricSample(row.key, row.values[1]),
      ] as const,
    }));
    const person = (p: Player) => ({
      name: playerName(p),
      avatar: p.avatarUrl,
      team: names[p.teamIndex],
      teamLogo: logos[p.teamIndex],
      sample: sample(p),
      profileMode: p.profileMode,
      metrics: (
        [
          ['rating', 'Rating'],
          ['adr', 'ADR'],
          ['kast', 'KAST'],
        ] as const
      ).flatMap(([key, label]) =>
        p.metrics[key].value == null ? [] : [{ label, value: metric(p.metrics[key], key) }],
      ),
      attributes: p.attributes
        .filter((a) => a.score != null)
        .map((a) => ({
          label: `${attrLabels[a.key]}${a.status === 'limited' ? ' *' : ''}`,
          value: String(a.score),
          width: a.score!,
        })),
    });
    let content: Content | undefined;
    let rail: StatsInsert['rail'];
    let railCenter: string | undefined;
    switch (page.kind) {
      case 'match':
        content = {
          kind: 'match',
          sides: sides.map((side) => ({
            name: names[side],
            logo: logos[side],
            records: [
              ...(bundle.records[side].series
                ? [{ value: record(bundle.records[side].series)!, label: '系列赛' }]
                : []),
              ...(bundle.records[side].maps
                ? [{ value: record(bundle.records[side].maps)!, label: '地图' }]
                : []),
            ],
          })),
          center: bundle.matchScore ? `${bundle.matchScore.a}–${bundle.matchScore.b}` : 'VS',
          badge: phaseNames[bundle.phase][1],
          ...(bundle.program?.scheduledAt && bundle.phase === 'prematch'
            ? { time: time(bundle.program.scheduledAt) }
            : {}),
          format: [
            date(bundle.program?.scheduledAt ?? null),
            bundle.program?.match?.format.toUpperCase(),
          ]
            .filter(Boolean)
            .join(' · '),
          ribbon: [bundle.program?.match?.stage ?? '', phaseNames[bundle.phase][0]],
        };
        break;
      case 'maps-info':
        content = { kind: 'maps-info', maps: page.maps.map((m) => mapPhoto(m.name)) };
        break;
      case 'maps':
        return {
          ...base,
          layout: 'maps',
          rows: page.maps.map((m) => ({
            label: mapName(m.name),
            artwork: m.name,
            values: sides.map((side) =>
              m.sides[side].winRate.value == null
                ? '—'
                : `${m.sides[side].winRate.value!.toFixed(0)}%`,
            ) as [string, string],
            samples: sides.map((side) => {
              const x = m.sides[side];
              return x.played == null
                ? '暂无统计'
                : x.played === 0
                  ? '0 图 · 暂无样本'
                  : `${x.played} 图${x.wins != null && x.losses != null ? ` · ${x.wins}胜${x.losses}负` : ''}`;
            }) as [string, string],
          })),
          rail:
            visible.length === 2
              ? [`上排 · ${names[visible[0]!]}`, `下排 · ${names[visible[1]!]}`]
              : [names[visible[0] ?? 0], ''],
        };
      case 'lineup':
        content = {
          kind: 'lineup',
          sides: visible.map((side) => ({
            name: names[side],
            showStats: page.lineupHasStats[side],
            players: chosen
              .filter((p) => p.teamIndex === side)
              .map((p) => ({
                name: playerName(p),
                avatar: p.avatarUrl,
                sample:
                  sample(p) ||
                  (p.metrics.rating.value == null && p.metrics.adr.value == null ? '暂无统计' : ''),
                values: [metric(p.metrics.rating, 'rating'), metric(p.metrics.adr, 'adr')],
              })),
          })),
        };
        break;
      case 'map-profile': {
        const side = visible[0] ?? 0;
        content = {
          kind: 'map-profile',
          maps: page.maps.map((m) => {
            const x = m.sides[side];
            return {
              ...mapPhoto(m.name),
              record: `${number(x.wins)}–${number(x.losses)}`,
              sample: x.played == null ? '' : `${x.played} 图`,
              ct: metric(x.ct),
              t: metric(x.t),
              detail: [
                x.rounds.value == null ? '' : `回合胜率 ${metric(x.rounds)}`,
                x.picks == null ? '' : `选图 ${x.picks} 次`,
              ]
                .filter(Boolean)
                .join(' · '),
            };
          }),
        };
        break;
      }
      case 'veto':
        content = {
          kind: 'veto',
          maps: page.maps.map((m) => ({
            ...mapPhoto(m.name),
            sides: visible.map((side) => ({
              name: names[side],
              values: [
                { label: '选', value: number(m.sides[side].picks) },
                { label: '禁', value: number(m.sides[side].bans) },
                { label: '决胜', value: number(m.sides[side].deciders) },
              ],
            })),
          })),
        };
        break;
      case 'bp':
        content = {
          kind: 'bp',
          steps: page.vetoSteps.map((step) => {
            const side = sides.find((i) => bundle.teams[i].entryId === step.entryId);
            return {
              ...mapPhoto(step.mapName),
              order: String(step.stepOrder).padStart(2, '0'),
              action:
                step.actionType === 'ban'
                  ? '禁用'
                  : step.actionType === 'pick'
                    ? '选用'
                    : step.actionType === 'decider'
                      ? '决胜图'
                      : `阵营 · ${step.side ?? '—'}`,
              ...(step.actionType === 'ban' || step.actionType === 'side_pick'
                ? { actionKind: step.actionType }
                : {}),
              ...(side != null ? { team: names[side], logo: logos[side] } : {}),
            };
          }),
        };
        break;
      case 'recent':
        content = {
          kind: 'recent',
          sides: visible.map((side) => ({
            name: names[side],
            ...(record(bundle.records[side].series)
              ? { record: record(bundle.records[side].series)! }
              : {}),
            matches: page.recentItems[side].map((item) => {
              const x = item.value;
              return {
                stage:
                  item.kind === 'series'
                    ? item.value.round != null
                      ? `ROUND ${item.value.round}`
                      : item.value.stage
                    : '单图',
                date: date(x.completedAt),
                opponent: x.opponent.name,
                logo: x.opponent.logoUrl,
                score: `${x.score}–${x.opponentScore}`,
                maps:
                  item.kind === 'series'
                    ? item.value.maps.map((m) => ({
                        name: mapName(m.mapName),
                        score: `${number(m.score)}–${number(m.opponentScore)}`,
                      }))
                    : [{ name: mapName(item.value.mapName), score: '' }],
              };
            }),
          })),
        };
        break;
      case 'players':
        return {
          ...base,
          layout: 'players',
          teams: pNames,
          logos: pAvatars,
          matchTeams: playerTeams,
          matchLogos: logos,
          rows: metricRows,
          playerSamples: [
            selected[0] ? sample(selected[0]) : '',
            selected[1] ? sample(selected[1]) : '',
          ],
        };
      case 'radar':
        return {
          ...base,
          layout: 'radar',
          teams: pNames,
          logos: pAvatars,
          matchTeams: playerTeams,
          matchLogos: logos,
          radarMode: bundle.radar?.mode ?? 'bars',
          playerMetrics: selected.map((p) => ({
            ...(p.metrics.rating.value != null
              ? { rating: metric(p.metrics.rating, 'rating') }
              : {}),
            ...(p.metrics.adr.value != null ? { adr: metric(p.metrics.adr, 'adr') } : {}),
          })),
          rows: (bundle.radar?.values ?? [])
            .filter((r) => bundle.radar?.visibleKeys.includes(r.key))
            .map((r) => ({
              label: attrLabels[r.key]!,
              values: [number(r.values[0]), number(r.values[1])],
              numericValues: r.values,
              samples: [
                selected[0] ? sample(selected[0]) : '',
                selected[1] ? sample(selected[1]) : '',
              ],
            })),
        };
      case 'profile': {
        const p =
          (profilePlayerId && page.playerIds.includes(profilePlayerId)
            ? find(profilePlayerId)
            : undefined) ?? (page.profileDefaultId ? find(page.profileDefaultId) : undefined);
        if (p) {
          content = { kind: 'profile', person: person(p) };
          rail = [
            playerName(p),
            p.limited ? '* 样本有限' : p.profileMode === 'attributes' ? '历史基准' : '',
          ];
        }
        break;
      }
      case 'ranking':
      case 'multikill': {
        const multi = page.kind === 'multikill';
        content = {
          kind: 'ranking',
          columns: multi
            ? ['多杀 / 100r', 'HS%', '残局胜 / 尝试', 'KPR', '回合']
            : ['Rating', 'ADR', 'K/D', 'KAST', '图数'],
          players: page.ranks.flatMap((r) => {
            const p = find(r.userId);
            if (!p) return [];
            return [
              {
                place: String(r.place),
                name: playerName(p),
                avatar: p.avatarUrl,
                team: names[p.teamIndex],
                values: multi
                  ? [
                      metric(p.metrics.multikill, 'multikill'),
                      metric(p.metrics.headshot, 'headshot'),
                      p.clutch[0] ? fraction(p.clutch[0].metric) || '—' : '—',
                      metric(p.metrics.kpr, 'kpr'),
                      number(p.rounds),
                    ]
                  : [
                      metric(p.metrics.rating, 'rating'),
                      metric(p.metrics.adr, 'adr'),
                      metric(p.metrics.kd, 'kd'),
                      metric(p.metrics.kast, 'kast'),
                      number(p.maps),
                    ],
              },
            ];
          }),
        };
        rail = ['本场阵容', `${page.totalItems} 位选手`];
        railCenter = multi ? 'MULTIKILL' : 'RATING';
        break;
      }
      case 'weapons':
        content = {
          kind: 'weapons',
          sides: visible.map((side) => ({
            name: names[side],
            weapons: page.weapons[side].map((w) => ({
              name: w.weapon,
              kills: String(w.kills),
              share: metric(w.share),
              ...(w.share.value != null ? { width: w.share.value } : {}),
            })),
          })),
        };
        railCenter = `TOP ${Math.max(...visible.map((side) => page.weapons[side].length), 0)}`;
        break;
      case 'community':
        content = {
          kind: 'community',
          sides: sides.map((side) => ({
            name: names[side],
            logo: logos[side],
            share:
              bundle.communityDisplay?.percentages[side] == null
                ? '—'
                : `${bundle.communityDisplay.percentages[side]!.toFixed(1)}%`,
          })),
        };
        rail = [
          '积分支持',
          bundle.communityDisplay ? `总积分 ${bundle.communityDisplay.total}` : '',
        ];
        break;
      case 'current-map': {
        const m = bundle.selectedMap;
        if (m)
          content = {
            kind: 'current-map',
            map: mapPhoto(m.mapName),
            score: `${number(m.score.a)} : ${number(m.score.b)}`,
            columns: bundle.summaryHasKAD ? ['K', 'A', 'D'] : [],
            sides: sides.map((side) => ({
              name: names[side],
              players: (side === 0 ? m.players.a : m.players.b).map((p) => ({
                name: p.name ?? '—',
                avatar: p.avatarUrl,
                ...(bundle.summaryHasKAD
                  ? { values: [number(p.kills), number(p.assists), number(p.deaths)] }
                  : {}),
              })),
            })),
          };
        break;
      }
      case 'series':
        content = {
          kind: 'series',
          maps: (bundle.program?.series?.maps ?? []).map((m) => ({
            ...mapPhoto(m.mapName),
            order: `MAP ${m.mapOrder}`,
            score: m.finalScore ? `${m.finalScore.a}–${m.finalScore.b}` : 'VS',
            status:
              m.status === 'completed'
                ? '已完成'
                : m.status === 'current'
                  ? '进行中'
                  : m.status === 'not_played'
                    ? '未进行'
                    : '待进行',
          })),
        };
        break;
      case 'economy':
        return { ...base, layout: 'columns', rows: metricRows };
      case 'advantage':
      case 'utility':
      case 'clutch':
        return {
          ...base,
          layout: 'cells',
          ...(page.kind === 'clutch'
            ? { teams: pNames, logos: pAvatars, matchTeams: playerTeams, matchLogos: logos }
            : {}),
          rows: metricRows,
        };
      case 'overview':
      case 'opening':
      case 'flash':
      case 'awp':
      case 'conversion':
        return { ...base, layout: 'comparison', rows: metricRows };
    }
    return {
      ...base,
      ...(content ? { content } : {}),
      ...(rail ? { rail } : {}),
      ...(railCenter ? { railCenter } : {}),
    };
  });
}
