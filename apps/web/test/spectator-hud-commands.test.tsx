// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../src/workspace/client', () => ({ desktopInvoke: invoke }));
import { SpectatorHudCommands } from '../src/preparation/SpectatorHudCommands';

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.restoreAllMocks();
  invoke.mockReset();
});

it('only copies the external-game CFG command after the host verifies and prepares it', async () => {
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<SpectatorHudCommands />));
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('准备并复制解说配置命令'),
  )!;
  expect(container.textContent).toContain('键位可能持久变化，Mizar 不会自动恢复');
  invoke.mockRejectedValueOnce(new Error('当前借用游戏已失效'));
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  expect(writeText).not.toHaveBeenCalled();
  expect(container.textContent).toContain('当前借用游戏已失效');
  invoke.mockResolvedValueOnce({ cfgReady: true });
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  expect(invoke).toHaveBeenLastCalledWith('observer_command', { action: 'prepare-cfg' });
  expect(writeText).toHaveBeenCalledExactlyOnceWith('exec mizar_observer.cfg');
  expect(container.textContent).toContain('执行结果尚未确认');
  act(() => root.unmount());
  container.remove();
});
