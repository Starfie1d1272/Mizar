// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  view: { version: '1.0.0', active: false, health: { state: 'disabled' } },
  native: vi.fn(),
}));
vi.mock('../src/preparation/client', () => ({ useLocalRead: () => mocks.view }));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.native }));
import { ObserverControls } from '../src/workspace/ObserverControls';

it('connects and stops from the workbench, retaining an actionable local error', async () => {
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  mocks.native.mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (text: string) => {
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
      await Promise.resolve();
    });
  };
  try {
    act(() => root.render(<ObserverControls />));
    await click('连接早源');
    const input = container.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '127.0.0.1:27025',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('连接');
    expect(mocks.native).toHaveBeenCalledWith('observer_command', {
      action: 'start',
      endpoint: '127.0.0.1:27025',
      password: '',
    });
    expect(container.querySelector('dialog')!.open).toBe(false);
    mocks.view = { ...mocks.view, active: true, health: { state: 'live' } };
    act(() => root.render(<ObserverControls />));
    expect(container.textContent).toContain('接收中');
    await click('停止观察器');
    expect(mocks.native).toHaveBeenLastCalledWith('observer_command', { action: 'stop' });
    mocks.native.mockRejectedValue(new Error('请检查 Steam 后重试。'));
    await click('停止观察器');
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('请检查 Steam 后重试。');
  } finally {
    act(() => root.unmount());
    container.remove();
    delete window.__TAURI_INTERNALS__;
  }
});
