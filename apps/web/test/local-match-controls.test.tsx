// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  invoke: vi.fn(),
  refresh: vi.fn(),
  view: {
    teams: [],
    activeLocalMatchId: 'current',
    canConfirmLocalExit: false,
    inUseMatchId: ((): string | null => 'current')(),
    matches: [
      {
        matchId: 'current',
        format: 'bo1',
        entrants: { a: { name: '当前队' }, b: { name: '对手' } },
      },
      { matchId: 'old', format: 'bo3', entrants: { a: { name: '旧队' }, b: { name: '另一队' } } },
    ],
    trashedMatches: [
      {
        document: {
          matchId: 'trash',
          format: 'bo1',
          entrants: { a: { name: '回收队' }, b: { name: '对手' } },
        },
      },
    ],
  },
}));
vi.mock('../src/preparation/tournament', () => ({
  useLocalTournament: () => ({ view: mocks.view, refresh: mocks.refresh }),
}));
vi.mock('../src/preparation/client', () => ({ command: mocks.command }));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.invoke }));
import { LocalMatchControls } from '../src/preparation/LocalMatchControls';

it('protects current matches, cancels without mutation and confirms recovery actions with busy feedback', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const errors: unknown[] = [];
  const action = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
  try {
    mocks.command.mockReset().mockResolvedValue({ ok: true });
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    await act(async () => {
      root.render(<LocalMatchControls action={action} />);
      await Promise.resolve();
    });
    const deletes = [...container.querySelectorAll('button')].filter(
      (item) => item.textContent === '删除本地比赛',
    );
    expect(deletes[0]!.disabled).toBe(true);
    await act(async () => {
      deletes[1]!.click();
      await Promise.resolve();
    });
    expect(container.querySelector('dialog')!.textContent).toContain('旧队 vs 另一队');
    await act(async () => {
      button('取消').click();
      await Promise.resolve();
    });
    expect(mocks.command).not.toHaveBeenCalled();
    await act(async () => {
      deletes[1]!.click();
      await Promise.resolve();
    });
    await act(async () => {
      button('移入回收站').click();
      await Promise.resolve();
    });
    expect(mocks.command).toHaveBeenCalledWith('/operator/local-match/trash', {
      matchId: 'old',
      confirmed: true,
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('比赛已移入回收站');
    const failure = new Error('资料变化，请刷新后重试。');
    mocks.command.mockRejectedValueOnce(failure);
    await act(async () => {
      button('恢复比赛').click();
      await Promise.resolve();
    });
    expect(errors).toEqual([failure]);
    expect(button('恢复比赛').disabled).toBe(false);
    await act(async () => {
      button('恢复比赛').click();
      await Promise.resolve();
    });
    expect(mocks.command).toHaveBeenLastCalledWith('/operator/local-match/restore', {
      matchId: 'trash',
      confirmed: true,
    });
    expect(container.textContent).toContain('比赛已恢复，请按需选择比赛');
    mocks.view.inUseMatchId = null;
    await act(async () => {
      root.render(<LocalMatchControls action={action} />);
      await Promise.resolve();
    });
    expect(deletes[0]!.disabled).toBe(false);
    await act(async () => {
      deletes[0]!.click();
      await Promise.resolve();
    });
    expect(container.querySelector('dialog')!.textContent).toContain('同时解除当前本地比赛选择');
    await act(async () => {
      button('移入回收站').click();
      await Promise.resolve();
    });
    expect(mocks.command).toHaveBeenLastCalledWith('/operator/local-match/trash', {
      matchId: 'current',
      confirmed: true,
      releaseCurrent: true,
    });
  } finally {
    mocks.view.inUseMatchId = 'current';
    act(() => root.unmount());
    container.remove();
    if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  }
});

it('requests Host cleanup before refreshing deletion eligibility and surfaces a failed confirmation', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const errors: unknown[] = [];
  const action = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const button = () =>
    [...container.querySelectorAll('button')].find(
      (item) => item.textContent === '关闭游戏并允许删除',
    );
  try {
    mocks.view.canConfirmLocalExit = true;
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.invoke.mockReset();
    act(() => root.render(<LocalMatchControls action={action} />));
    expect(button()).toBeUndefined();
    window.__TAURI_INTERNALS__ = { invoke: mocks.invoke };
    act(() => root.render(<LocalMatchControls action={action} />));
    const failure = new Error('游戏退出尚未确认，请重试。');
    mocks.invoke.mockRejectedValueOnce(failure);
    await act(async () => {
      button()!.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('finish_managed_cs2');
    expect(errors).toEqual([failure]);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(button()!.disabled).toBe(false);
    expect(container.textContent).not.toContain('游戏收尾已完成');
    let finish: () => void = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const confirmationButton = button()!;
    await act(async () => {
      confirmationButton.click();
      await Promise.resolve();
    });
    expect(confirmationButton.disabled).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('游戏收尾已完成，已刷新比赛的删除状态');
  } finally {
    mocks.view.canConfirmLocalExit = false;
    delete window.__TAURI_INTERNALS__;
    act(() => root.unmount());
    container.remove();
  }
});
