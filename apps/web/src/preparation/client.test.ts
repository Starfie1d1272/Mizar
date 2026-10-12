// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionAction, type Production } from './client';

const preparation: Production = { mode: 'preparation', revision: 'one', canEnter: true };

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

function setup(
  failure?: 'launch' | 'production' | 'restore' | 'presentation' | 'network',
  actualMode = 'preparation',
  newlyStarted = true,
  running = true,
  gameStates: { running?: boolean; pending?: boolean; busy?: boolean }[] = [],
) {
  const calls: string[] = [];
  const invoke = vi.fn((command: string) => {
    calls.push(command);
    if (failure === 'launch' && command === 'start_managed_cs2')
      return Promise.reject(new Error('请先退出已打开的 CS2'));
    if (failure === 'restore' && command === 'finish_managed_cs2')
      return Promise.reject(new Error('等待 CS2 退出后恢复'));
    if (failure === 'presentation' && command === 'present_production')
      return Promise.reject(new Error('窗口未打开'));
    return Promise.resolve(
      command === 'gsi_status'
        ? { installed: true, conflict: false }
        : command === 'cs2_config_status'
          ? (gameStates.shift() ?? {
              running,
              pending: true,
              phase: running ? 'running' : 'uncertain',
            })
          : command === 'start_managed_cs2'
            ? newlyStarted
            : undefined,
    );
  });
  window.__TAURI_INTERNALS__ = {
    invoke: async <T>(command: string) => (await invoke(command)) as T,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      calls.push(path);
      if (failure === 'network' && path === '/operator/production')
        return Promise.reject(new Error('网络中断'));
      if (path === '/local/v1/demo-test')
        return Promise.resolve(new Response(JSON.stringify({ active: false, phase: 'idle' })));
      if (path === '/local/v1/production')
        return Promise.resolve(new Response(JSON.stringify({ ...preparation, mode: actualMode })));
      return Promise.resolve(
        path.includes('/obs')
          ? new Response(JSON.stringify({ connection: 'connected', findings: [] }))
          : new Response(JSON.stringify({ message: '制作状态已变化' }), {
              status: failure === 'production' ? 409 : 200,
            }),
      );
    }),
  );
  return calls;
}

describe('managed CS2 production entry and cleanup', () => {
  it('cancels the entry intent when navigation changes during Steam startup', async () => {
    vi.useFakeTimers();
    const calls = setup(undefined, 'preparation', true, false);
    const entry = productionAction('enter', preparation);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain('cs2_config_status');
    window.history.pushState(null, '', '/diagnostics');
    await vi.advanceTimersByTimeAsync(1000);
    await entry;
    expect(calls.filter((call) => call === 'start_managed_cs2')).toHaveLength(1);
    expect(calls).not.toContain('/operator/production');
    expect(calls).not.toContain('finish_managed_cs2');
  });
  it('reads actual live state after an uncertain commit and keeps the newly started game', async () => {
    const calls = setup('network', 'live');
    await expect(productionAction('enter', preparation)).rejects.toThrow(
      '制作已开始，但工作台尚未打开',
    );
    expect(calls.at(-1)).toBe('/local/v1/production');
    expect(calls).not.toContain('finish_managed_cs2');
  });
});
