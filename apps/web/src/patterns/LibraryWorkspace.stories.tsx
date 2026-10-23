import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button, Select, StatusBanner } from '../ui/index.js';
import { LibraryWorkspace } from './LibraryWorkspace';
import scheduleFixture from './library-schedule.fixture.json';

const meta = { title: '组合组件/比赛浏览', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const items = [
  { id: 'first', title: '甲队 vs 乙队', summary: '10-19 20:00 · BO3', status: '当前本场' },
  {
    id: 'next',
    title: '丙队 vs 丁队 · 队名较长时仍可完整阅读',
    summary: '待排期 · BO3',
    status: '候选，尚未载入',
  },
];
function Example({
  empty = false,
  failed = false,
  crowded = false,
}: {
  empty?: boolean;
  failed?: boolean;
  crowded?: boolean;
}) {
  const entries = crowded ? scheduleFixture.items : items;
  const [selected, setSelected] = useState(entries[0]!.id);
  return (
    <LibraryWorkspace
      items={empty ? [] : entries}
      selectedId={selected}
      onSelect={setSelected}
      browserHeader={
        <Select label="浏览赛事" defaultValue="event">
          <option value="event">邀请赛</option>
        </Select>
      }
      browserActions={<Button disabled={failed}>刷新比赛</Button>}
      status={<span>{failed ? '同步失败，保留上次资料' : '已读取比赛资料'}</span>}
      header={<span>{selected === 'first' ? '当前本场' : '候选比赛'}</span>}
      footer={
        <>
          <small>浏览不会切换本场</small>
          <Button variant="primary" disabled={failed || empty}>
            确认载入为本场
          </Button>
        </>
      }
      emptyMessage="暂无比赛"
    >
      {failed ? (
        <StatusBanner tone="warning">资料刷新失败，请重试；已载入资料保持不变。</StatusBanner>
      ) : null}
      <h2>{empty ? '选择比赛查看详情' : entries.find((item) => item.id === selected)?.title}</h2>
      <p>名单、地图与禁选资料在这里查看。</p>
    </LibraryWorkspace>
  );
}
export const LibraryBrowse: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('combobox', { name: '浏览赛事' })).toHaveFocus();
    const next = canvas.getByRole('button', { name: /丙队 vs 丁队/ });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await expect(next).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('heading', { name: /丙队 vs 丁队/ })).toBeVisible();
  },
};
export const LibraryEmpty: Story = { render: () => <Example empty /> };
export const LibraryRefreshFailed: Story = { render: () => <Example failed /> };

export const LibraryLongSchedule: Story = {
  render: () => (
    <div style={{ minWidth: 1280 }}>
      <Example crowded />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByLabelText('赛事赛程');
    const matches = within(list).getAllByRole('button');
    await expect(matches).toHaveLength(23);
    // Every line belongs inside its own hit target, even when the schedule scrolls.
    for (const match of matches) {
      const bounds = match.getBoundingClientRect();
      for (const line of Array.from(match.children)) {
        const textBounds = line.getBoundingClientRect();
        await expect(textBounds.top).toBeGreaterThanOrEqual(bounds.top);
        await expect(textBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
      }
    }
    await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    const last = matches.at(-1)!;
    last.focus();
    await userEvent.keyboard('{Enter}');
    await expect(last).toHaveAttribute('aria-pressed', 'true');
    await expect(
      canvas.getByRole('heading', { name: scheduleFixture.items.at(-1)!.title }),
    ).toBeVisible();
  },
};
