// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.invoke }));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: () => null,
  productionAction: vi.fn(),
  checkObsBeforeLaunch: vi.fn(),
}));

import { Cs2LaunchSettings } from '../src/preparation/Cs2LaunchSettings';

let root: Root;
let container: HTMLDivElement;
let response: Record<string, unknown>;
const idle = {
  preserveQuality: true,
  pending: false,
  running: false,
  message: null,
  busy: false,
  phase: 'idle',
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  response = idle;
  mocks.invoke.mockReset().mockImplementation(() => Promise.resolve(response));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.useRealTimers();
});
async function poll(next: Record<string, unknown>) {
  response = next;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}
async function render() {
  await act(async () => {
    root.render(<Cs2LaunchSettings />);
    await Promise.resolve();
  });
}

describe('CS2 configuration progress', () => {
  it('keeps idle controls stable across routine Host lock contention', async () => {
    await render();
    for (let index = 0; index < 4; index += 1) {
      await poll({ busy: true, phase: 'idle' });
      expect(container.textContent).not.toContain('正在检查');
      expect(container.textContent).not.toContain('打开备份目录');
      expect(container.querySelector('button[role="switch"]')?.hasAttribute('disabled')).toBe(
        false,
      );
      expect(container.textContent).toContain('保留原画质 · 开');
      await poll(idle);
    }
  });

  it('shows one operation region and retains confirmed backup facts while starting', async () => {
    response = { ...idle, pending: true, running: true, phase: 'running' };
    await render();
    await poll({ busy: true, phase: 'starting' });
    expect(container.textContent?.match(/正在启动 CS2，等待 Steam…/g)).toHaveLength(1);
    expect(container.textContent).toContain('打开备份目录');
    expect(container.textContent).toContain('退出 CS2 并恢复设置');
    expect(container.querySelector('button[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    await poll({ busy: true, phase: 'restoring' });
    expect(container.textContent?.match(/正在关闭游戏并恢复配置…/g)).toHaveLength(1);
  });
});
