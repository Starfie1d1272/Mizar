import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatsInsertView } from '@mizar/hud-view';

const meta = {
  title: 'Program/Stats Insert',
  component: StatsInsertView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StatsInsertView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MapPerformance: Story = {
  args: {
    insert: {
      title: '地图表现',
      subtitle: 'MAP POOL',
      layout: 'maps',
      scope: '本届 · 赛前',
      teams: ['Team A', 'Team B'],
      rows: ['de_mirage', 'de_ancient', 'de_dust2'].map((map) => ({
        label: map.slice(3).toUpperCase(),
        artwork: map,
        values: ['50.0%', '66.7%'] as const,
        samples: ['10 图', '9 图'] as const,
      })),
    },
  },
};

export const Pistol: Story = {
  args: {
    insert: {
      title: '手枪局与第二回合',
      subtitle: 'PISTOL & CONVERSION',
      scope: '本届 · 赛前',
      teams: ['Team A', 'Team B'],
      layout: 'columns',
      rows: ['手枪局', '赢手枪后的第二回合', '输手枪后的第二回合'].map((label) => ({
        label,
        values: ['50.0%', '66.7%'] as const,
        samples: ['5 / 10', '6 / 9'] as const,
      })),
    },
  },
};

export const Utility: Story = {
  args: {
    insert: {
      title: '道具支援',
      subtitle: 'UTILITY',
      scope: '本届 · 赛前',
      teams: ['Team A', 'Team B'],
      layout: 'cells',
      rows: ['道具伤害 / 回合', '闪光助攻 / 回合', '敌方致盲秒数 / 颗', '敌方致盲秒数 / 回合'].map(
        (label, index) => ({
          label,
          values: ['2.0', '3.0'] as const,
          samples:
            index === 2 ? (['100 颗', '90 颗'] as const) : (['100 回合', '90 回合'] as const),
        }),
      ),
    },
  },
};
