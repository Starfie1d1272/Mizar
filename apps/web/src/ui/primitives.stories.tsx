import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  Button,
  Checkbox,
  Dialog,
  Divider,
  EmptyState,
  Field,
  IconButton,
  Panel,
  Select,
  StatusBanner,
  StatusPill,
  type StatusTone,
} from './index.js';

const meta = { title: '基础组件/状态与交互', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ButtonsExample() {
  const [count, setCount] = useState(0);
  return (
    <Panel style={{ fontSize: 'var(--mizar-type-size-readable)' }}>
      <Button variant="primary" onClick={() => setCount(count + 1)}>
        确认
      </Button>{' '}
      <Button>取消</Button> <Button disabled>不可用</Button> <Button loading>保存</Button>{' '}
      <IconButton label="关闭预览">×</IconButton> <Button aria-current="page">当前任务</Button>
      <p role="status">已确认 {count} 次</p>
    </Panel>
  );
}
export const Buttons: Story = {
  name: '按钮',
  render: () => <ButtonsExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const confirm = canvas.getByRole('button', { name: '确认' });
    await expect(getComputedStyle(confirm).fontSize).toBe('14px');
    await userEvent.hover(confirm);
    await userEvent.unhover(confirm);
    await userEvent.tab();
    await expect(confirm).toHaveFocus();
    await expect(confirm.matches(':focus-visible')).toBe(true);
    await expect(getComputedStyle(confirm).outlineStyle).toBe('solid');
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('status')).toHaveTextContent('已确认 1 次');
    await expect(canvas.getByRole('button', { name: '不可用' })).toBeDisabled();
    const loading = canvas.getByRole('button', { name: '处理中…' });
    await expect(loading).toBeDisabled();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    await expect(getComputedStyle(loading.querySelector('.mizar-spinner')!).animationName).toBe(
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'mizar-loading',
    );
    const target = canvas.getByRole('button', { name: '关闭预览' }).getBoundingClientRect();
    await expect(target.width).toBeGreaterThanOrEqual(24);
    await expect(target.height).toBeGreaterThanOrEqual(24);
  },
};

export const Fields: Story = {
  name: '输入与选择',
  render: () => (
    <Panel>
      <Field label="赛事名称" placeholder="填写赛事名称" />
      <Divider />
      <Field label="阶段" tone="warning" message="请确认阶段名称。" />
      <Divider />
      <Field label="队伍 A" tone="success" message="资料已保存。" defaultValue={'Falcons'} />
      <Divider />
      <Field label="队伍名称" tone="danger" message="请填写队伍名称。" required />
      <Divider />
      <Field label="队伍 B" disabled value={'Natus Vincere'} />
      <Divider />
      <Select label="赛制" defaultValue={'bo3'}>
        <option value="bo1">BO1</option>
        <option value="bo3">BO3</option>
        <option value="bo5">BO5</option>
      </Select>
      <Divider />
      <Select label="赛制（不可编辑）" disabled defaultValue={'bo3'}>
        <option value="bo3">BO3</option>
      </Select>
    </Panel>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    const field = canvas.getByRole('textbox', { name: '赛事名称' });
    await expect(field).toHaveFocus();
    await userEvent.type(field, 'ESL Pro League Season 24');
    await expect(field).toHaveValue('ESL Pro League Season 24');
    const warning = canvas.getByRole('textbox', { name: '阶段' });
    const success = canvas.getByRole('textbox', { name: '队伍 A' });
    await expect(getComputedStyle(warning).borderTopColor).not.toBe(
      getComputedStyle(field).borderTopColor,
    );
    await expect(getComputedStyle(success).borderTopColor).not.toBe(
      getComputedStyle(field).borderTopColor,
    );
    await expect(getComputedStyle(success).borderTopColor).not.toBe(
      getComputedStyle(warning).borderTopColor,
    );
    await expect(canvas.getByRole('textbox', { name: '队伍名称' })).toHaveAccessibleDescription(
      '请填写队伍名称。',
    );
    await expect(canvas.getByRole('textbox', { name: '队伍名称' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(canvas.getByRole('textbox', { name: '队伍 B' })).toBeDisabled();
    const select = canvas.getByRole('combobox', { name: '赛制' });
    // Native select keeps the platform keyboard/accessible selection contract.
    await userEvent.selectOptions(select, 'bo5');
    await expect(select).toHaveValue('bo5');
    await expect(canvas.getByRole('combobox', { name: '赛制（不可编辑）' })).toBeDisabled();
  },
};

export const SelectionList: Story = {
  name: '选项列表',
  render: () => (
    <Panel>
      <Field label="队伍名称" defaultValue={'Falcons'} />
      <Select label="赛制选项" size={3} defaultValue={'bo3'}>
        <option value="bo1">BO1</option>
        <option value="bo3">BO3</option>
        <option value="bo5">BO5</option>
      </Select>
    </Panel>
  ),
};

const tones: readonly StatusTone[] = ['success', 'warning', 'danger', 'info'];
const labels = {
  success: '资料已保存',
  warning: '请确认比赛',
  danger: '连接失败，请重试',
  info: '等待比赛数据',
};
export const Status: Story = {
  name: '状态提示',
  render: () => (
    <Panel>
      {tones.map((tone) => (
        <div key={tone}>
          <StatusPill tone={tone}>{labels[tone]}</StatusPill>
          <StatusBanner tone={tone}>{labels[tone]}</StatusBanner>
          <Divider />
        </div>
      ))}
    </Panel>
  ),
};
export const Empty: Story = {
  name: '空状态',
  render: () => (
    <EmptyState title="尚未选择比赛" action={<Button variant="primary">选择比赛</Button>}>
      选择比赛后可检查播出画面。
    </EmptyState>
  ),
};

function DialogExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开设置</Button>
      <Dialog open={open} title="预览设置" onClose={() => setOpen(false)}>
        <Field label="预览名称" />
        <Divider />
      </Dialog>
    </>
  );
}
export const Modal: Story = {
  name: '对话框',
  render: () => <DialogExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: '打开设置' });
    await userEvent.click(trigger);
    const dialog = canvas.getByRole('dialog', { name: '预览设置' });
    await expect(dialog).toBeVisible();
    const field = canvas.getByRole('textbox', { name: '预览名称' });
    await expect(field).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: '关闭' }));
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(canvas.getByRole('button', { name: '关闭' }));
    await expect(dialog).not.toBeVisible();
  },
};

function CheckboxExample() {
  const [checked, setChecked] = useState(true);
  return (
    <Panel>
      <Checkbox
        label="显示附加信息"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
        message="保留核心比赛信息。"
      />
      <Checkbox
        label="不可编辑"
        disabled
        checked
        onChange={() => {
          throw new Error('Disabled checkbox changed');
        }}
      />
    </Panel>
  );
}
export const Checkboxes: Story = {
  name: '复选框',
  render: () => <CheckboxExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: '显示附加信息' });
    await expect(checkbox).toBeChecked();
    await userEvent.tab();
    await expect(checkbox).toHaveFocus();
    await expect(getComputedStyle(checkbox).outlineStyle).toBe('solid');
    await userEvent.keyboard(' ');
    await expect(checkbox).not.toBeChecked();
    await userEvent.click(canvas.getByText('显示附加信息'));
    await expect(checkbox).toBeChecked();
    await expect(canvas.getByRole('checkbox', { name: '不可编辑' })).toBeDisabled();
  },
};
