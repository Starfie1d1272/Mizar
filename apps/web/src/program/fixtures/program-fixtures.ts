import type { ProgramSnapshot } from '@mizar/protocol/program';
import { realProgramFixtures, type RealProgramProvenance } from './real-program-fixtures.js';
import {
  HUD_EDITOR_REAL_BP_FIXTURES,
  syntheticProgramFixtures,
  getPresentationFixtureReplaySource,
  SYNTHETIC_FIXTURE_PROVENANCE,
} from './synthetic-program-fixtures.js';

import {
  objectiveFocusedFixtures,
  OBJECTIVE_FOCUSED_PROVENANCE,
} from './objective-focused-fixtures.js';

const aliases = {
  'live-canonical': 'real-live-rich',
  'bomb-planted': 'real-planted',
  'bomb-defusing': 'real-defusing',
  'timeout-ct': 'real-timeout-ct',
  'series-halftime-swap': 'real-halftime-after',
  'series-timeout-a': 'real-timeout-ct',
  'series-timeout-b': 'real-timeout-t',
  'series-paused': 'real-paused',
  'gameplay-map-ended-gg': 'real-gameover',
} as const;
export const programFixtures = {
  ...objectiveFocusedFixtures,
  ...syntheticProgramFixtures,
  ...(Object.fromEntries(
    Object.entries(realProgramFixtures).map(([id, record]) => [id, record.snapshot]),
  ) as { readonly [K in keyof typeof realProgramFixtures]: ProgramSnapshot }),
  ...(Object.fromEntries(
    Object.entries(aliases).map(([id, source]) => [id, realProgramFixtures[source].snapshot]),
  ) as { readonly [K in keyof typeof aliases]: ProgramSnapshot }),
};
export type ProgramFixtureId = keyof typeof programFixtures;
export const PROGRAM_FIXTURE_IDS = Object.keys(programFixtures) as ProgramFixtureId[];
// The operator preview stays small; the full registry remains available to visual/unit tests.
export const HUD_EDITOR_FIXTURE_GROUPS = [
  {
    label: '真实遥测回放 · BP 取自 2026 NJU Rivals',
    ids: [
      'real-live-rich',
      'real-bomb-dropped',
      'real-planted',
      'real-defusing',
      'real-post-explosion-freezetime',
      'real-timeout-ct',
      'real-halftime-after',
      'real-gameover',
      'gameplay-map-ended-gg',
    ],
  },
  {
    label: '真实 Rivals BP/赛果 · 游戏回放为独立样本',
    ids: [
      'bp-rivals-final-map4',
      'bp-rivals-final-result',
      'bp-rivals-semi-a-result',
      'bp-rivals-semi-b-result',
    ],
  },
  { label: '必要边界', ids: ['focused-avatar', 'awaiting-neutral'] },
] as const satisfies readonly {
  readonly label: string;
  readonly ids: readonly ProgramFixtureId[];
}[];
export const HUD_EDITOR_DEFAULT_FIXTURE_ID: ProgramFixtureId = 'real-live-rich';
export const HUD_EDITOR_RIVALS_BP_FIXTURE_IDS = Object.keys(
  HUD_EDITOR_REAL_BP_FIXTURES,
) as (keyof typeof HUD_EDITOR_REAL_BP_FIXTURES)[];
export type ProgramFixtureProvenance =
  | RealProgramProvenance
  | { readonly kind: 'synthetic-edge' | 'synthetic-presentation'; readonly reason: string };
export const PROGRAM_FIXTURE_PROVENANCE: Readonly<
  Record<ProgramFixtureId, ProgramFixtureProvenance>
> = {
  ...SYNTHETIC_FIXTURE_PROVENANCE,
  ...OBJECTIVE_FOCUSED_PROVENANCE,
  ...(Object.fromEntries(
    Object.entries(realProgramFixtures).map(([id, record]) => [id, record.provenance]),
  ) as { readonly [K in keyof typeof realProgramFixtures]: RealProgramProvenance }),
  ...(Object.fromEntries(
    Object.entries(aliases).map(([id, source]) => [id, realProgramFixtures[source].provenance]),
  ) as { readonly [K in keyof typeof aliases]: RealProgramProvenance }),
};

const realFixtureIdBySnapshot = new WeakMap<ProgramSnapshot, keyof typeof realProgramFixtures>();
for (const [id, record] of Object.entries(realProgramFixtures)) {
  realFixtureIdBySnapshot.set(record.snapshot, id as keyof typeof realProgramFixtures);
}

/** Resolve the real GSI replay behind a real fixture or presentation-only overlay. */
export function getProgramFixtureReplaySource(id: string) {
  const snapshot = getHudEditorFixture(id);
  if (snapshot === null) return null;
  const sourceId =
    getPresentationFixtureReplaySource(snapshot) ?? realFixtureIdBySnapshot.get(snapshot);
  return sourceId === undefined || sourceId === null ? null : realProgramFixtures[sourceId];
}

export const PROGRAM_FIXTURE_LABELS: Readonly<Record<ProgramFixtureId, string>> = {
  'focused-avatar': '观察选手 · 显示头像',
  'focused-long-name': '观察选手 · 长名称与队徽',
  'focused-low-health-edge': '观察选手 · 低生命边界',
  'focused-shells-edge': '观察选手 · 霰弹弹药边界',
  'focused-grenade-edge': '观察选手 · 当前手雷边界',
  'focused-unavailable-edge': '观察选手 · 统计与弹药缺失',
  'objective-live-4v5-edge': '存活人数 · 4 对 5',
  'objective-late-plant-edge': '安装 · 中途接入',
  'objective-late-planted-edge': 'C4 · 中途接入',
  'objective-unavailable-edge': 'C4 · 时间证据缺失',
  'objective-no-kit-edge': '拆弹 · 无拆弹器',
  'objective-dual-progress-edge': '拆弹 · 双进度轨道',
  'objective-paused-edge': 'C4 · 比赛暂停',
  'objective-long-defuser': '拆弹 · 长选手名称',
  'objective-stale-edge': 'C4 · 数据过期',
  ...(Object.fromEntries(
    Object.keys(realProgramFixtures).map((id) => [id, `真实回放 · ${id.slice(5)}`]),
  ) as Record<keyof typeof realProgramFixtures, string>),
  'real-live-rich': '实战 · 完整 5v5',
  'real-bomb-dropped': '实战 · C4 掉落与阵亡',
  'real-planted': '实战 · C4 已安装',
  'real-defusing': '实战 · 拆弹与阵亡',
  'real-post-explosion-freezetime': '实战 · 回合切换',
  'real-timeout-ct': '实战 · CT 暂停',
  'real-halftime-after': '实战 · 半场换边',
  'real-gameover': '实战 · 地图结束',
  'gameplay-map-ended-gg': '单图结束 · GG 过渡预览',
  'player-rails-freezetime': '选手栏 · 回合切换前置边界',
  'awaiting-neutral': '等待初始状态',
  'live-neutral': '实时中 · 未绑定队伍',
  'live-canonical': '实时中 · 已匹配队伍',
  'context-stale': '比赛上下文过期',
  'identity-degraded': '选手身份部分确认',
  'identity-mismatch': '选手身份不匹配',
  'bomb-planted': '炸弹已安装',
  'bomb-defusing': '正在拆弹',
  'timeout-ct': 'CT 暂停',
  'stress-long-labels': '长名称压力场景',
  'player-rails-eco': '选手栏 · 低装备边界（合成）',
  'player-rails-dead-observed': '选手栏 · 阵亡观察边界（合成）',
  'player-rails-missing-summary': '选手栏 · 汇总证据缺失',
  'player-rails-carryover': '选手栏 · 回合切换延续',
  'series-bo1': 'BO1 系列赛',
  'series-bo3-map1': 'BO3 · Map 1',
  'series-bo5': 'BO5 中盘',
  'series-bo5-pick-loss': 'BO5 · 选图方失利（合成）',
  'bp-rivals-final-map4': 'Rivals 总决赛 · 第 4 图前',
  'bp-rivals-final-result': 'Rivals 总决赛 · 完赛',
  'bp-rivals-semi-a-result': 'Rivals 半决赛 · 大猛男队对 D’avenir',
  'bp-rivals-semi-b-result': 'Rivals 半决赛 · Clarys 对 Plasma',
  'series-not-played': '系列赛未进行地图',
  'series-logo-mixed': '队伍 Logo 有/无',
  'series-halftime-swap': '半场换边',
  'series-timeout-a': 'A 队战术暂停',
  'series-timeout-b': 'B 队战术暂停',
  'series-paused': '比赛暂停',
  'series-decider': '决胜图',
  'series-partial-history': '回合历史不完整',
  'series-history-unavailable': '回合历史不可用',
  'series-mapping-unavailable': '队伍映射暂不可用',
  'series-round-unavailable': '回合编号不可用',
  'series-overtime-history': '加时回合密度',
  'series-long-labels': '系列赛长名称压力场景',
};

export function getProgramFixture(id: string): ProgramSnapshot | null {
  return Object.prototype.hasOwnProperty.call(programFixtures, id)
    ? programFixtures[id as ProgramFixtureId]
    : null;
}
export function getHudEditorFixture(id: string): ProgramSnapshot | null {
  if (Object.prototype.hasOwnProperty.call(HUD_EDITOR_REAL_BP_FIXTURES, id)) {
    return HUD_EDITOR_REAL_BP_FIXTURES[id as keyof typeof HUD_EDITOR_REAL_BP_FIXTURES];
  }
  return getProgramFixture(id);
}
export function getProgramFixtureProvenance(id: string): ProgramFixtureProvenance | null {
  return Object.prototype.hasOwnProperty.call(PROGRAM_FIXTURE_PROVENANCE, id)
    ? PROGRAM_FIXTURE_PROVENANCE[id as ProgramFixtureId]
    : null;
}
