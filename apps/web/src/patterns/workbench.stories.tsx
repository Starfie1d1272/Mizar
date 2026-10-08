import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button, Field, StatusBanner } from '../ui/index.js';
import { Inspector, PreviewFrame, Workbench } from './index.js';

const meta = { title: '组合组件/预览与控制', component: Workbench } satisfies Meta<
  typeof Workbench
>;
export default meta;
type Story = StoryObj<typeof meta>;
const args = {
  preview: (
    <PreviewFrame label="播出预览">
      <div>
        <strong>{'Falcons'}</strong> 对阵 <strong>{'Natus Vincere'}</strong>
        <p>BO3 · 瑞士轮 2–1 组</p>
      </div>
    </PreviewFrame>
  ),
  inspector: (
    <Inspector title="预览控制">
      <Field label="预览名称" />
      <StatusBanner tone="info">ESL Pro League Season 24 比赛资料</StatusBanner>
      <Button variant="primary">确认预览</Button>
    </Inspector>
  ),
};
export const Product: Story = {
  name: '产品界面',
  args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: '播出预览' })).toBeVisible();
    await userEvent.tab();
    await expect(canvas.getByRole('textbox', { name: '预览名称' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: '确认预览' })).toHaveFocus();
  },
};
export const Technical: Story = {
  ...Product,
  name: '诊断界面',
  parameters: { surface: 'technical' },
};
