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
  qualityPreset: 'preserve',
  frameRateLimit: 60,
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
  it('saves the explicit number-key choice and shows a skipped-preset reason without reporting success', async () => {
    await render();
    const select =
      container.querySelector<HTMLSelectElement>('select[aria-label="数字键观战"]') ??
      [...container.querySelectorAll('select')].find((element) =>
        element.querySelector('option[value="enabled"]'),
      )!;
    expect(select.value).toBe('preserve');
    await act(async () => {
      select.value = 'enabled';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith('set_cs2_preferences', {
      qualityPreset: 'preserve',
      frameRateLimit: 60,
      spectatorNumberKeys: true,
    });
    await poll({
      ...idle,
      spectatorNumberKeys: true,
      spectatorWarning: '原值缺失，数字键预设未应用。',
    });
    expect(container.textContent).toContain('原值缺失，数字键预设未应用。');
  });

  it('preserves an unsaved draft after a failed save and allows retry', async () => {
    await render();
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'high';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    mocks.invoke.mockImplementation((command) =>
      command === 'set_cs2_preferences'
        ? Promise.reject(new Error('磁盘不可写'))
        : Promise.resolve(idle),
    );
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('磁盘不可写');
    await poll(idle);
    expect(select.value).toBe('high');
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
    expect(container.textContent).not.toContain('已保存，下次启动生效。');
  });

  it('keeps idle controls stable across routine Host lock contention', async () => {
    await render();
    for (let index = 0; index < 4; index += 1) {
      await poll({ busy: true, phase: 'idle' });
      expect(container.textContent).not.toContain('正在检查');
      expect(container.textContent).not.toContain('打开备份目录');
      expect(container.querySelector('select')?.hasAttribute('disabled')).toBe(false);
      expect(container.querySelector('select')?.value).toBe('preserve');
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
    expect(container.querySelector('select')?.hasAttribute('disabled')).toBe(true);
    await poll({ busy: true, phase: 'restoring' });
    expect(container.textContent?.match(/正在关闭本次游戏…/g)).toHaveLength(1);
  });

  it('saves quality and frame limit together and reports unlimited-frame risk in text', async () => {
    await render();
    const frameRate = container.querySelectorAll('select')[1]!;
    await act(async () => {
      frameRate.value = '0';
      frameRate.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'set_cs2_preferences')).toBe(
      false,
    );
    await poll(idle);
    expect(frameRate.value).toBe('0');
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith('set_cs2_preferences', {
      qualityPreset: 'preserve',
      frameRateLimit: 0,
      spectatorNumberKeys: false,
    });
    expect(container.textContent).toContain('已保存，下次启动生效。');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'start_managed_cs2')).toBe(
      false,
    );
    await poll({ ...idle, frameRateLimit: 0 });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '导致雷达或播出画面卡顿',
    );
  });
});
