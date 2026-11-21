import type { Meta, StoryObj } from '@storybook/react-vite';
import { Panel, SourceBadge } from './index.js';

const meta = {
  title: '基础组件/来源标识 SourceBadge',
  component: SourceBadge,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof SourceBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
  name: '示例与本场状态',
  args: { kind: 'sample' },
  render: () => (
    <Panel
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--mizar-layout-gap)',
        alignItems: 'center',
      }}
    >
      <SourceBadge kind="sample" />
      <SourceBadge kind="sample" label="回放示例 · 非本场" />
      <SourceBadge kind="sample" compact />
      <SourceBadge kind="live" />
      <SourceBadge kind="live" label="本场 BP" />
      <SourceBadge kind="live" compact />
    </Panel>
  ),
};
