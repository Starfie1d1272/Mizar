// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDefaultHudConfigDocument } from '@mizar/hud-config';
import type { DemoTestView } from '../src/preparation/demo-test';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  preflight: vi.fn(),
  mutation: vi.fn(),
  trial: null as DemoTestView | null,
  running: false,
  canPreserve: false,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.invoke }));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: () => mocks.trial,
  checkObsBeforeLaunch: mocks.preflight,
}));
vi.mock('../src/preparation/cs2-status', () => ({
  useCs2Status: () => ({ status: { running: mocks.running, canPreserve: mocks.canPreserve } }),
}));
vi.mock('../src/realtime/hud-config-client', () => ({
  useHudConfigEditorClient: () => ({
    status: 'ready',
    document: createDefaultHudConfigDocument(),
    revision: 'editor-1',
    error: null,
    applyResponse: vi.fn(),
  }),
  mutateHudConfig: mocks.mutation,
}));
import { DemoTestPanel } from '../src/preparation/DemoTestPanel';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.__TAURI_INTERNALS__ = { invoke: mocks.invoke };
  mocks.trial = {
    active: false,
    phase: 'idle',
    requestId: null,
    teamAName: '',
    teamBName: '',
    dataReady: false,
  };
  mocks.running = false;
  mocks.canPreserve = false;
  mocks.invoke.mockReset();
  mocks.preflight.mockReset().mockResolvedValue(true);
  mocks.mutation.mockReset();
  act(() => root.render(<DemoTestPanel />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.__TAURI_INTERNALS__;
});
function button(label: string) {
  return [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
}

it('keeps a native selection when the next picker is cancelled and starts with defaults and a token', async () => {
  await click('准备 Demo 试播');
  expect(button('启动 Demo 试播').disabled).toBe(true);
  mocks.invoke.mockResolvedValueOnce({ token: 'native-token', name: '中文 含空格.dem' });
  await click('选择本地 Demo');
  mocks.invoke.mockResolvedValueOnce(null);
  await click('选择本地 Demo');
  expect(container.textContent).toContain('中文 含空格.dem');
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(mocks.preflight).toHaveBeenCalledWith(true);
  expect(mocks.invoke).toHaveBeenLastCalledWith('start_demo_test', {
    token: 'native-token',
    teamAName: '队伍 A',
    teamBName: '队伍 B',
  });
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it('preserves the selection and exposes a preflight error without launching', async () => {
  await click('准备 Demo 试播');
  mocks.invoke.mockResolvedValueOnce({ token: 'selected', name: 'match.dem' });
  await click('选择本地 Demo');
  mocks.preflight.mockRejectedValueOnce(new Error('请先停止推流'));
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(container.textContent).toContain('请先停止推流');
  expect(container.textContent).toContain('match.dem');
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it('retries the same selected demo with explicitly preserved settings after configuration failure', async () => {
  await click('准备 Demo 试播');
  mocks.invoke.mockResolvedValueOnce({ token: 'selected', name: 'match.dem' });
  await click('选择本地 Demo');
  mocks.invoke.mockRejectedValueOnce(new Error('配置接管未完成'));
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(container.textContent).toContain('match.dem');
  expect(button('保持原设置启动试播')).toBeUndefined();
  mocks.canPreserve = true;
  act(() => root.render(<DemoTestPanel />));
  await click('保持原设置启动试播');
  expect(mocks.preflight).toHaveBeenCalledWith(true);
  expect(mocks.invoke).toHaveBeenLastCalledWith('start_demo_test', {
    token: 'selected',
    teamAName: '队伍 A',
    teamBName: '队伍 B',
    preserveSettings: true,
  });
});

it('keeps recovery visible and uses the native finish transaction instead of clearing browser state', async () => {
  mocks.trial = {
    active: true,
    phase: 'recovery',
    requestId: 'recovered-id',
    teamAName: 'A',
    teamBName: 'B',
    dataReady: false,
  };
  act(() => root.render(<DemoTestPanel />));
  mocks.invoke.mockRejectedValueOnce(new Error('游戏尚未退出'));
  await click('重试结束并恢复');
  expect(mocks.invoke).toHaveBeenCalledWith('finish_demo_test', { requestId: 'recovered-id' });
  expect(container.textContent).toContain('游戏尚未退出');
  expect(button('重试结束并恢复').disabled).toBe(false);
  expect(container.querySelector('form')).toBeNull();
});

it('waits for a running game, attempts entry once and leaves an explicit retry after failure', async () => {
  mocks.trial = {
    active: true,
    phase: 'starting',
    requestId: 'launch-id',
    teamAName: 'A',
    teamBName: 'B',
    dataReady: false,
  };
  act(() => root.render(<DemoTestPanel />));
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.running = true;
  mocks.invoke.mockRejectedValueOnce(new Error('工作台打开失败'));
  await act(async () => {
    root.render(<DemoTestPanel />);
    await Promise.resolve();
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('工作台打开失败');
  act(() => root.render(<DemoTestPanel />));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  mocks.invoke.mockResolvedValueOnce(undefined);
  await click('打开试播工作台');
  expect(mocks.invoke).toHaveBeenLastCalledWith('enter_demo_test', { requestId: 'launch-id' });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
