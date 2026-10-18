import type { Meta, StoryObj } from '@storybook/react-vite';
import { DesktopCanvas } from './DesktopCanvas';
import { Button } from '../ui/index.js';

const meta = {
  title: 'Patterns/DesktopCanvas',
  component: DesktopCanvas,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DesktopCanvas>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Product: Story = { args: { kind: 'product', children: <Button>进入工作台</Button> } };
export const Dock: Story = { args: { kind: 'dock', children: <Button>返回游戏</Button> } };
