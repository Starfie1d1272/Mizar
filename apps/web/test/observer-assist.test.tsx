// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_OBSERVER_SETTINGS } from '@mizar/protocol/assist';
const mocks = vi.hoisted(() => ({
  view: {
    settings: {
      enabled: false,
      expectedDelaySeconds: 120,
      leadSeconds: 7,
    },
    connection: null,
  },
  command: vi.fn(),
  native: vi.fn(),
  runtime: {
    active: true,
    pending: false,
    error: null as 'observer_operation_failed' | null,
    retryAvailable: true,
    failed: false,
    health: { state: 'live' },
    terminal: undefined as undefined | { reason: string },
  },
  cs2Status: null as null | { preferMulnx: boolean; running: boolean; observerHudPending: boolean },
  production: { mode: 'preparation' },
  observer: ((): Record<string, unknown> => ({}))(),
}));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: (path: string) =>
    path === '/local/v1/observer'
      ? mocks.runtime
      : path === '/local/v1/production'
        ? mocks.production
        : mocks.view,
  command: mocks.command,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.native }));
vi.mock('../src/preparation/cs2-status', () => ({
  useCs2Status: () => ({ status: mocks.cs2Status, refresh: vi.fn() }),
}));
vi.mock('../src/realtime', () => ({
  useLocalChannelClient: () => ({ subscribe: () => () => {}, getSnapshot: () => mocks.observer }),
}));
import {
  GameAutomationSettingsPanel,
  ObserverSettingsPanel,
} from '../src/preparation/ObserverSettings';
import { MulnxToolControls } from '../src/orchestration/MulnxToolControls';
import { ObserverHints } from '../src/workspace/ObserverHints';
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.view.settings = { ...DEFAULT_OBSERVER_SETTINGS };
  mocks.runtime = {
    active: true,
    pending: false,
    error: null,
    retryAvailable: true,
    failed: false,
    health: { state: 'live' },
    terminal: undefined,
  };
  mocks.production.mode = 'preparation';
  mocks.cs2Status = null;
  mocks.command.mockReset().mockResolvedValue({});
  mocks.native.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.__TAURI_INTERNALS__;
});
it('offers the two timing controls and saves observer preferences independently of game controls', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  act(() => root.render(<ObserverSettingsPanel />));
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type=number]')].map((e) => e.value),
  ).toEqual(['120', '7']);
  expect(container.textContent).toContain('113');
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((e) => e.textContent?.includes('保存观察辅助'))!
      .click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenCalledWith('/operator/observer-assist', {
    action: 'configure',
    settings: DEFAULT_OBSERVER_SETTINGS,
  });
  expect(mocks.native).not.toHaveBeenCalled();
});
it('keeps the disabled feature out of connection preparation and the workbench', () => {
  mocks.observer = { state: 'live', current: { payload: { availability: 'unavailable' } } };
  act(() =>
    root.render(
      <>
        <ObserverHints />
      </>,
    ),
  );
  expect(container.innerHTML).toBe('');
});
it('shows private slots and countdowns from the assist channel, and clears on reconnect', () => {
  mocks.observer = {
    state: 'live',
    current: {
      payload: {
        observer: {
          state: 'ready',
          leadSeconds: 7,
          hints: [
            {
              id: 'test',
              remainingSeconds: 7,
              attacker: { name: 'Long player name', observerSlot: 2 },
              victim: { name: 'Victim', observerSlot: 9 },
            },
          ],
        },
      },
    },
  };
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('7 秒后');
  expect([...container.querySelectorAll('kbd')].map((e) => e.textContent)).toEqual(['3', '0']);
  mocks.observer = { state: 'reconnecting' };
  act(() => root.render(<ObserverHints />));
  expect(container.innerHTML).toBe('');
});

it('distinguishes reconnecting from a terminal failure and dispatches the configured native retry', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.view.settings.enabled = true;
  mocks.observer = {
    state: 'live',
    current: { payload: { observer: { state: 'connecting', hints: [] } } },
  };
  mocks.runtime.health.state = 'reconnecting';
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('正在重连早源');
  expect(container.querySelector('button')).toBeNull();
  mocks.runtime.pending = true;
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('正在准备早源');
  expect(container.querySelector('button')).toBeNull();
  mocks.runtime.pending = false;
  mocks.runtime.error = 'observer_operation_failed';
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('观察辅助准备失败');
  mocks.runtime.failed = true;
  mocks.runtime.terminal = { reason: 'initialization-timeout' };
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('早源连接超时');
  mocks.runtime.retryAvailable = false;
  act(() => root.render(<ObserverHints />));
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  mocks.runtime.retryAvailable = true;
  act(() => root.render(<ObserverHints />));
  await act(async () => {
    container.querySelector('button')!.click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith('observer_command', {
    action: 'start-configured',
  });
});
it('requests configured assistance when enabled during a live session', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.production.mode = 'live';
  mocks.runtime.pending = true;
  act(() => root.render(<ObserverSettingsPanel />));
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  mocks.runtime.pending = false;
  act(() => root.render(<ObserverSettingsPanel />));
  act(() => {
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  });
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '保存观察辅助设置')!
      .click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith('observer_command', {
    action: 'start-configured',
  });
});

it('restores a pending game HUD through its dedicated native command', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.cs2Status = { preferMulnx: true, running: true, observerHudPending: true };
  act(() => root.render(<GameAutomationSettingsPanel />));
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '恢复游戏 HUD')!
      .click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith('observer_command', {
    action: 'restore-hud',
  });
});

it.each(['queued', 'unknown'])(
  'confirms explicit MulNX stop and reports %s without retrying or claiming unload',
  async (result) => {
    window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
    mocks.native.mockResolvedValue({ result, execution: 'unconfirmed' });
    act(() =>
      root.render(
        <MulnxToolControls
          tool={{
            installed: 'test',
            latest: 'test',
            launchProtocol: 1,
            busy: false,
            message: '',
            packs: [],
          }}
        />,
      ),
    );
    const stop = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '停止 MulNX 控制',
    )!;
    act(() => stop.click());
    const dialog = () => document.querySelector<HTMLElement>('dialog[open]')!;
    expect(dialog().textContent).toContain('结束本场制作、恢复游戏 HUD');
    expect(dialog().textContent).toContain('CS2 保持运行');
    act(() =>
      [...dialog().querySelectorAll('button')]
        .find((button) => button.textContent === '取消')!
        .click(),
    );
    expect(mocks.native).not.toHaveBeenCalled();
    act(() => stop.click());
    await act(async () => {
      const confirm = [...dialog().querySelectorAll('button')].find(
        (button) => button.textContent === '结束制作并停止控制',
      )!;
      confirm.click();
      confirm.click();
      await Promise.resolve();
    });
    expect(mocks.native).toHaveBeenCalledExactlyOnceWith('mulnx_control', { action: 'stop' });
    expect(container.textContent).toContain(
      result === 'queued' ? '已入队，执行结果待确认' : '结果待确认',
    );
    expect(container.textContent).not.toContain('已卸载');
    expect(stop.disabled).toBe(true);
  },
);
it('shows an unborrowed-game stop rejection at the MulNX controls', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.native.mockRejectedValue(new Error('请先明确借用本场 CS2。'));
  act(() =>
    root.render(
      <MulnxToolControls
        tool={{
          installed: 'test',
          latest: 'test',
          launchProtocol: 1,
          busy: false,
          message: '',
          packs: [],
        }}
      />,
    ),
  );
  act(() =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '停止 MulNX 控制')!
      .click(),
  );
  await act(async () => {
    [...document.querySelectorAll('dialog[open] button')]
      .find((button) => button.textContent === '结束制作并停止控制')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith('mulnx_control', { action: 'stop' });
  expect(container.textContent).toContain('请先明确借用本场 CS2。');
});
