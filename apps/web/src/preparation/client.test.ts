// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionAction, type Production } from './client';

const preparation: Production = { mode: 'preparation', revision: 'one', canEnter: true };

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

function setup(
  failure?: 'launch' | 'production' | 'restore' | 'presentation' | 'network',
  actualMode = 'preparation',
  newlyStarted = true,
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
  it('starts the game after OBS readiness and before committing live presentation', async () => {
    const calls = setup();
    await productionAction('enter', preparation);
    expect(calls).toEqual([
      'gsi_status',
      '/local/v1/obs',
      'start_managed_cs2',
      '/operator/production',
      'present_production',
    ]);
  });
  it('does not enter production when the game cannot start', async () => {
    const calls = setup('launch');
    await expect(productionAction('enter', preparation)).rejects.toThrow('请先退出');
    expect(calls).toEqual(['gsi_status', '/local/v1/obs', 'start_managed_cs2']);
  });
  it('redisplays existing live or hidden production without readiness or game launch', async () => {
    for (const mode of ['live', 'hidden'] as const) {
      const calls = setup();
      await productionAction('enter', { ...preparation, mode });
      expect(calls).toEqual(['/operator/production', 'present_production']);
    }
  });
  it('hides the workspace without closing the game', async () => {
    const calls = setup();
    await productionAction('hide', { ...preparation, mode: 'live' });
    expect(calls).toEqual(['/operator/production', 'present_production']);
  });
  it('finishes the safe scene and source cleanup before closing the owned game', async () => {
    const calls = setup();
    await productionAction('finish', { ...preparation, mode: 'live' });
    expect(calls).toEqual(['/operator/production', 'present_production', 'finish_managed_cs2']);
  });
  it('keeps the game running when production cleanup fails', async () => {
    const calls = setup('production');
    await expect(productionAction('finish', preparation)).rejects.toThrow('制作状态已变化');
    expect(calls).toEqual(['/operator/production']);
  });
  it('returns to the preparation window before reporting an outstanding restoration', async () => {
    const calls = setup('restore');
    await expect(productionAction('finish', preparation)).rejects.toThrow('等待 CS2');
    expect(calls).toEqual(['/operator/production', 'present_production', 'finish_managed_cs2']);
  });
  it('reads actual live state after an uncertain commit and keeps the newly started game', async () => {
    const calls = setup('network', 'live');
    await expect(productionAction('enter', preparation)).rejects.toThrow(
      '制作已开始，但工作台尚未打开',
    );
    expect(calls.at(-1)).toBe('/local/v1/production');
    expect(calls).not.toContain('finish_managed_cs2');
  });
  it('keeps a reused managed game after a revision conflict and describes the remaining action', async () => {
    const calls = setup('production', 'preparation', false);
    await expect(productionAction('enter', preparation)).rejects.toThrow('受管理的 CS2 已保留');
    expect(calls).not.toContain('finish_managed_cs2');
  });
  it('still closes and restores after production finishes but presentation fails', async () => {
    const calls = setup('presentation');
    await expect(productionAction('finish', preparation)).rejects.toThrow('窗口未打开');
    expect(calls).toEqual(['/operator/production', 'present_production', 'finish_managed_cs2']);
  });
});
