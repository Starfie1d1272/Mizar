// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SpectatorHudCommands } from '../src/preparation/SpectatorHudCommands';

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.restoreAllMocks();
});

it.each([false, true])(
  'copies HUD commands without exposing manual CFG preparation (compact=%s)',
  async (compact) => {
    const invoke = vi.fn();
    window.__TAURI_INTERNALS__ = { invoke };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<SpectatorHudCommands compact={compact} />));
    expect(container.textContent).not.toContain('准备并复制解说配置命令');
    expect(container.textContent).not.toContain('键位可能持久变化');
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('复制隐藏命令'),
    )!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('cl_draw_only_deathnotices 1');
    expect(container.textContent).toContain('已复制，尚未执行');
    expect(invoke).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  },
);
