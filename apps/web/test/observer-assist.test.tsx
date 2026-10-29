import {
  observerFailureReason,
  type ObserverRuntimeView,
} from '../src/preparation/observer-preparation';
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
  inventory: {
    releases: [] as { preparedId: string; tag: string | null; state: 'available' | 'damaged' }[],
  },
  catalog: {
    resources: [],
    tool: { installed: 'old', latest: 'new', busy: false, packs: [] },
  },
  observer: ((): Record<string, unknown> => ({}))(),
}));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: (path: string) =>
    path === '/local/v1/resource-library'
      ? mocks.catalog
      : path === '/local/v1/mulnx-releases'
        ? mocks.inventory
        : path === '/local/v1/observer'
          ? mocks.runtime
          : path === '/local/v1/production'
            ? mocks.production
            : mocks.view,
  command: mocks.command,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.native }));
vi.mock('../src/operator/OperatorShell', () => ({
  OperatorShell: ({ children }: { children: React.ReactNode }) => children,
}));
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
import { ResourceLibraryPage } from '../src/resource-library/ResourceLibraryPage';
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
  mocks.inventory.releases = [];
  mocks.cs2Status = null;
  mocks.command.mockReset().mockResolvedValue({});
  mocks.native.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  delete window.__TAURI_INTERNALS__;
});
it('offers the two timing controls and saves observer preferences independently of game controls', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  act(() => root.render(<ObserverSettingsPanel />));
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type=number]')].map((e) => e.value),
  ).toEqual(['120', '5']);
  expect(container.textContent).toContain('115');
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
          timingBasis: 'estimated',
          expectedDelaySeconds: 120,
          waitingReason: null,
          nextWindowSeconds: 0,
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
it('saves auxiliary preferences without confirming a connection or issuing game commands', async () => {
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
  expect(mocks.native).not.toHaveBeenCalled();
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

it('reports unknown MulNX stop once even on double confirmation', async () => {
  const result = 'unknown';
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.native.mockResolvedValue({ result, execution: 'unconfirmed' });
  act(() =>
    root.render(
      <MulnxToolControls
        runtimeOnly
        tool={{
          installed: 'test',
          latest: 'test',
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
  await act(async () => {
    const confirm = [...dialog().querySelectorAll('button')].find(
      (button) => button.textContent === '结束制作并停止控制',
    )!;
    confirm.click();
    confirm.click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith('mulnx_control', { action: 'stop' });
  expect(container.textContent).toContain('停止控制正在确认');
  expect(container.textContent).not.toContain('已卸载');
  expect(stop.disabled).toBe(true);
});
it('explains a rejected MulNX update check and allows retry', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.native.mockRejectedValueOnce(new Error('mulnx_metadata_http_403'));
  act(() =>
    root.render(
      <MulnxToolControls
        maintenanceOnly
        tool={{ installed: 'old', latest: 'new', busy: false, message: '', packs: [] }}
      />,
    ),
  );
  const update = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '更新',
  )!;
  expect(container.textContent).not.toContain('启动 MulNX 工作台');
  expect(container.textContent).not.toContain('停止 MulNX 控制');
  await act(async () => {
    update.click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('GitHub 拒绝了请求');
  expect(container.textContent).toContain('请稍后重试');
  await act(async () => {
    update.click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('MulNX 版本准备已完成');
});
it('keeps a downloaded MulNX version available when selection is blocked', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.native.mockResolvedValueOnce({ preparedId: 'prepared-id', tag: 'new' });
  mocks.native.mockRejectedValueOnce(new Error('请先退出 CS2'));
  act(() =>
    root.render(
      <MulnxToolControls
        tool={{ installed: 'old', latest: null, busy: false, message: '', packs: [] }}
      />,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => {
    button('下载最新版本').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('已选版本：old');
  expect(container.textContent).toContain('已下载版本：new');
  expect(container.textContent).toContain('运行版本：未确认');
  await act(async () => {
    button('使用已下载版本').click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenLastCalledWith('mulnx_control', {
    action: 'select',
    preparedId: 'prepared-id',
  });
  expect(container.textContent).toContain('请先退出 CS2');
  expect(container.textContent).toContain('已下载版本：new');
  mocks.native.mockResolvedValueOnce({ version: 'new', cameraReady: false });
  await act(async () => {
    button('使用已下载版本').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('已选择 new');
  expect(container.textContent).toContain('镜头资源已变化');
});
it('shows prepared versions read from storage after reopening the controls', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.inventory.releases = [{ preparedId: 'saved', tag: 'saved-version', state: 'available' }];
  act(() =>
    root.render(
      <MulnxToolControls
        tool={{ installed: 'old', latest: null, busy: false, message: '', packs: [] }}
      />,
    ),
  );
  expect(container.textContent).toContain('已下载版本：saved-version');
  const select = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === '使用已下载版本',
  )!;
  await act(async () => {
    select.click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledWith('mulnx_control', {
    action: 'select',
    preparedId: 'saved',
  });
});
it('shows the available MulNX maintenance action after checking versions', () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  const render = (latest: string | null) =>
    act(() =>
      root.render(
        <MulnxToolControls maintenanceOnly tool={{ installed: 'v1', latest, busy: false }} />,
      ),
    );
  render(null);
  expect(container.textContent).toContain('检查更新');
  expect(container.textContent).not.toContain('重新安装');
  render('v1');
  expect(container.textContent).toContain('重新安装');
  render('v2');
  expect(
    [...container.querySelectorAll('button')].some((button) => button.textContent === '更新'),
  ).toBe(true);
});
it('keeps the downloaded version available when native selection is blocked', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.native.mockResolvedValueOnce({ preparedId: 'prepared-id', tag: 'new' });
  mocks.native.mockRejectedValueOnce(new Error('请先退出 CS2'));
  act(() =>
    root.render(
      <MulnxToolControls maintenanceOnly tool={{ installed: 'old', latest: null, busy: false }} />,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => {
    button('下载最新版本').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('已下载：new');
  await act(async () => {
    button('使用此版本').click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenLastCalledWith('mulnx_control', {
    action: 'select',
    preparedId: 'prepared-id',
  });
  expect(container.textContent).toContain('请先退出 CS2');
  expect(container.textContent).toContain('已下载：new');
});
it('shows the recorded running version independently of the selected version', async () => {
  window.__TAURI_INTERNALS__ = {
    invoke: <T,>() => Promise.resolve({ runningVersion: 'running-v1' } as T),
  };
  await act(async () => {
    root.render(<ResourceLibraryPage />);
    await Promise.resolve();
  });
  const rows = [...container.querySelectorAll('dl div')];
  expect(rows.find((row) => row.textContent?.includes('已选版本'))?.textContent).toContain('old');
  expect(rows.find((row) => row.textContent?.includes('运行版本'))?.textContent).toContain(
    'running-v1',
  );
});

it('retains the download receipt when filtering the resource catalog', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.native.mockResolvedValueOnce({ preparedId: 'prepared-id', tag: 'new' });
  act(() => root.render(<ResourceLibraryPage />));
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => {
    button('下载最新版本').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('已下载：new');
  act(() => button('素材').click());
  expect(container.textContent).not.toContain('已下载：new');
  act(() => button('工具').click());
  expect(container.textContent).toContain('已下载：new');
  await act(async () => {
    button('使用此版本').click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenLastCalledWith('mulnx_control', {
    action: 'select',
    preparedId: 'prepared-id',
  });
});
it('shows saved and damaged versions from the owner in the resource catalog', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  mocks.inventory.releases = [
    { preparedId: 'saved', tag: 'saved-version', state: 'available' },
    { preparedId: 'damaged', tag: null, state: 'damaged' },
  ];
  act(() => root.render(<ResourceLibraryPage />));
  expect(container.textContent).toContain('已下载：saved-version');
  expect(container.textContent).toContain('已下载：文件损坏');
  const buttons = [...container.querySelectorAll('button')].filter(
    (item) => item.textContent === '使用此版本',
  );
  expect(buttons).toHaveLength(1);
  await act(async () => {
    buttons[0]!.click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenLastCalledWith('mulnx_control', {
    action: 'select',
    preparedId: 'saved',
  });
});
it('gives specific repair guidance for known startup causes and diagnostic context for unknown failures', () => {
  const view: ObserverRuntimeView = {
    active: false,
    failed: true,
    pending: false,
    error: null,
    retryAvailable: true,
    health: { state: 'failed' },
  };
  for (const [reason, text] of [
    ['output-directory-unavailable', '数据目录是否可写'],
    ['output-parent-unavailable', '数据目录是否可写'],
    ['configuration-boundary', '未接受连接配置'],
    ['node-runtime-probe-failed', '运行环境检查失败'],
    ['native-start-failed', '游戏与组件状态'],
  ] as const)
    expect(observerFailureReason({ ...view, terminal: { reason } })).toContain(text);
  const unknown = observerFailureReason({
    ...view,
    terminal: { reason: 'unclassified', stage: 'eof', attemptId: 'diagnostic-123' },
  });
  expect(unknown).toContain('eof');
  expect(unknown).toContain('diagnostic-123');
  expect(unknown).not.toContain('核对本场连接');
});

it('hides the hint area while no event is ready', () => {
  mocks.view.settings.enabled = true;
  const observer = {
    state: 'ready',
    timingBasis: 'estimated',
    expectedDelaySeconds: 120,
    waitingReason: 'waiting-event',
    nextWindowSeconds: null as number | null,
    hints: [],
    calibrationState: 'held',
    effectiveDelaySeconds: 121,
  };
  mocks.observer = { state: 'live', current: { payload: { observer } } };
  act(() => root.render(<ObserverHints />));
  expect(container.querySelector('.workspace-observer-assist')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
  observer.waitingReason = 'buffering';
  observer.nextWindowSeconds = 113;
  act(() => root.render(<ObserverHints />));
  expect(container.querySelector('.workspace-observer-assist')).toBeNull();
});

it('orders private hints by actual remaining time, retains ties, expires locally and leaves input unchanged', () => {
  vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] });
  const hints = Object.freeze(
    (
      [
        ['three', 3],
        ['equal-first', 5],
        ['equal-second', 5],
        ['fraction-low', 5.1],
        ['fraction-high', 5.9],
        ['seven', 7],
      ] as const
    ).map(([id, remainingSeconds]) =>
      Object.freeze({
        id,
        remainingSeconds,
        attacker: Object.freeze({ name: id, observerSlot: 2 }),
        victim: Object.freeze({ name: 'Victim', observerSlot: 9 }),
      }),
    ),
  );
  const original = JSON.stringify(hints);
  mocks.observer = {
    state: 'live',
    current: {
      payload: {
        observer: {
          state: 'ready',
          timingBasis: 'estimated',
          expectedDelaySeconds: 120,
          leadSeconds: 7,
          waitingReason: null,
          nextWindowSeconds: 0,
          hints,
        },
      },
    },
  };
  const names = () =>
    [...container.querySelectorAll('li strong')].map((element) => element.textContent);
  const times = () =>
    [...container.querySelectorAll('.observer-hints__time')].map((element) => element.textContent);
  act(() => root.render(<ObserverHints />));
  expect(names()).toEqual([
    'seven',
    'fraction-high',
    'fraction-low',
    'equal-first',
    'equal-second',
    'three',
  ]);
  // Both fractional values display six, but actual time still determines their order.
  expect(times()).toEqual(['7 秒后', '6 秒后', '6 秒后', '5 秒后', '5 秒后', '3 秒后']);
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(names()).toEqual([
    'seven',
    'fraction-high',
    'fraction-low',
    'equal-first',
    'equal-second',
  ]);
  expect(times()).toEqual(['4 秒后', '3 秒后', '3 秒后', '2 秒后', '2 秒后']);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(names()).toEqual(['seven', 'fraction-high', 'fraction-low']);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(names()).toEqual([]);
  expect(JSON.stringify(hints)).toBe(original);
});

it('shows recalibration as unavailable rather than ready with a stale delay', () => {
  mocks.view.settings.enabled = true;
  mocks.observer = {
    state: 'live',
    current: {
      payload: {
        observer: {
          state: 'unavailable',
          timingBasis: 'estimated',
          calibrationState: 'reacquiring',
          expectedDelaySeconds: 120,
          effectiveDelaySeconds: 120,
          waitingReason: 'calibration-reacquiring',
          nextWindowSeconds: null,
          hints: [],
        },
      },
    },
  };
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('正在重新校准延迟');
  expect(container.textContent).not.toContain('保持上次校准');
});

it('shows MulNX download progress and cancellation in resource management', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  Object.assign(mocks.catalog.tool, {
    phase: 'downloading',
    source: '南大云盘',
    downloadedBytes: 12,
    totalBytes: 34,
    busy: true,
  });
  try {
    await act(async () => {
      root.render(<ResourceLibraryPage />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('南大云盘');
    expect(container.textContent).toContain('12 / 34 字节');
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === '取消下载'),
    ).toBe(true);
  } finally {
    Object.assign(mocks.catalog.tool, {
      phase: 'idle',
      source: null,
      downloadedBytes: 0,
      totalBytes: 0,
      busy: false,
    });
  }
});
