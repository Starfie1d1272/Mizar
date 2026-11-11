import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Field, Panel, Button } from '../ui/index.js';
import { ToolShell } from './ToolShell';

const meta = {
  title: '组合组件/工具窗口',
  component: ToolShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ToolShell>;
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

export const ResponsiveTool: Story = {
  args: {
    title: '长内容工具示例',
    responsive: true,
    children: (
      <main>
        <h1>长内容工具示例</h1>
        {Array.from({ length: 8 }, (_, index) => (
          <Panel key={index}>
            <Field label={`示例设置 ${index + 1}`} />
            <p>缩小窗口后可用滚轮或键盘查看后续设置，工具标题保持可见。</p>
          </Panel>
        ))}
        <Button>保存示例设置</Button>
      </main>
    ),
  },
};

export const FillTool: Story = {
  args: {
    title: '内部画布工具示例',
    context: <div>示例会话</div>,
    fill: true,
    children: (
      <div style={{ height: '100%', overflow: 'auto' }}>{ResponsiveTool.args.children}</div>
    ),
  },
};
