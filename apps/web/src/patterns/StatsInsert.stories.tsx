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
      subtitle: 'MAP PERFORMANCE',
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
