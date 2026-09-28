import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Field, Panel, Button } from '../ui/index.js';
import { ToolShell } from './ToolShell';

const meta = { title: '组合组件/工具窗口', component: ToolShell } satisfies Meta<typeof ToolShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Tool: Story = {
  args: {
    title: '节目预览',
    children: (
      <main>
        <Panel>
          <h1>节目预览</h1>
          <Field label="预览名称" />
          <Button disabled>等待数据</Button>
        </Panel>
      </main>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('navigation', { name: '制作导航' })).toBeNull();
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: '跳到工具内容' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('textbox', { name: '预览名称' })).toHaveFocus();
  },
};
