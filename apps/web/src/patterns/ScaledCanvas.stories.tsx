import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../ui/index.js';
import { AspectRatioCanvas, MinBudgetCanvas } from './ScaledCanvas';

const meta = {
  title: 'Patterns/ScaledCanvas',
  component: AspectRatioCanvas,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AspectRatioCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AspectRatio: Story = {
  args: {
    width: 1920,
    height: 1080,
    children: <Button>进入工作台</Button>,
  },
};

export const MinBudget: StoryObj<typeof MinBudgetCanvas> = {
  render: () => (
    <MinBudgetCanvas minWidth={1280} minHeight={240}>
      <Button>返回游戏</Button>
    </MinBudgetCanvas>
  ),
};
