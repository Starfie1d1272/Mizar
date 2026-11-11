import type { ProgramFixtureId } from './program-fixtures';

// The operator preview stays small; the full registry remains available to visual/unit tests.
export const HUD_EDITOR_FIXTURE_GROUPS = [
  {
    label: 'EPL S24 · Falcons 对 NAVI',
    ids: [
      'epl-live',
      'epl-freeze',
      'epl-planting',
      'epl-planted',
      'epl-defusing',
      'epl-timeout',
      'epl-halftime',
      'epl-map-result',
      'epl-match-result',
    ],
  },
  { label: '必要边界', ids: ['awaiting-neutral'] },
] as const satisfies readonly {
  readonly label: string;
  readonly ids: readonly ProgramFixtureId[];
}[];
export const HUD_EDITOR_DEFAULT_FIXTURE_ID = 'epl-live' as const;

export type HudEditorFixtureId = (typeof HUD_EDITOR_FIXTURE_GROUPS)[number]['ids'][number];

export const HUD_EDITOR_FIXTURE_LABELS: Readonly<Record<HudEditorFixtureId, string>> = {
  'epl-live': 'Inferno · 完整 5v5',
  'epl-freeze': 'Inferno · 第 4 回合冻结',
  'epl-planting': 'Inferno · 安装 C4',
  'epl-planted': 'Inferno · C4 已安装',
  'epl-defusing': 'Inferno · 拆弹',
  'epl-timeout': 'Inferno · Falcons 战术暂停',
  'epl-halftime': 'Inferno · 半场换边',
  'epl-map-result': 'Inferno · 单图结果',
  'epl-match-result': 'Mirage · 整场结果',
  'awaiting-neutral': '等待初始状态',
};
