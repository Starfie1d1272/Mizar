// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerObserverPreparation } from './observer-preparation';
import { productionAction, type Production } from './client';

interface RecordedControl {
  operation: string;
  phase: string;
  evidence: {
    taskId?: string;
    operationId?: string;
    parentOperationId?: string | null;
    kind?: string;
    evidence?: {
      result?: string;
      reason?: string;
      error?: { message?: string; cause?: { message?: string } };
    };
  };
}
const controls: RecordedControl[] = [];
const nativeArgs: { command: string; args?: Record<string, unknown> }[] = [];
const requests: { path: string; headers: Headers }[] = [];
const preparation: Production = { mode: 'preparation', revision: 'one', canEnter: true };

afterEach(() => {
  controls.length = 0;
  nativeArgs.length = 0;
  requests.length = 0;
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

function setup(
  failure?:
    'launch' | 'mulnx' | 'production' | 'restore' | 'presentation' | 'network' | 'trial' | 'assist',
  actualMode = 'preparation',
  newlyStarted = true,
  running = true,
  gameStates: {
    running?: boolean;
    pending?: boolean;
    busy?: boolean;
    preferMulnx?: boolean;
  }[] = [],
  observerEnabled = false,
  skipGameHud = false,
) {
  registerObserverPreparation(() => Promise.resolve(true));
  const calls: string[] = [];
  const invoke = vi.fn((command: string) => {
    calls.push(command);
    if (failure === 'assist' && command === 'observer_command')
      return Promise.reject(new Error('HUD 原值读取失败'));
    if (failure === 'launch' && command === 'start_managed_cs2')
      return Promise.reject(new Error('请先退出已打开的 CS2'));
    if (failure === 'mulnx' && command === 'launch_mulnx')
      return Promise.reject(new Error('请先关闭冲突程序：完美世界竞技平台'));
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
          : command === 'launch_mulnx'
            ? { pid: 42, created: '134000000000000000' }
            : command === 'start_managed_cs2'
              ? newlyStarted
              : undefined,
    );
  });
  window.__TAURI_INTERNALS__ = {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      nativeArgs.push({ command, ...(args ? { args } : {}) });
      return (await invoke(command)) as T;
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      calls.push(path);
      if (path === '/debug/control-event')
        controls.push(JSON.parse(init!.body as string) as RecordedControl);
      else requests.push({ path, headers: new Headers(init?.headers) });
      if (failure === 'network' && path === '/operator/production')
        return Promise.reject(new Error('网络中断'));
      if (path === '/local/v1/observer-assist')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              settings: { enabled: observerEnabled },
              capabilities: { skipGameHud },
            }),
          ),
        );
      if (path === '/local/v1/demo-test')
        return Promise.resolve(
          new Response(JSON.stringify({ active: failure === 'trial', phase: 'idle' })),
        );
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
  it('starts configured private assistance after committing production and presenting the workbench', async () => {
    const calls = setup(
      undefined,
      'preparation',
      false,
      true,
      [{ preferMulnx: false, running: false, pending: false }],
      true,
    );
    await productionAction('enter', preparation);
    expect(calls).toContain('start_managed_cs2');
    expect(calls).not.toContain('launch_mulnx');
    expect(calls.indexOf('observer_command')).toBeGreaterThan(calls.indexOf('present_production'));
    expect(calls.indexOf('observer_command')).toBeGreaterThan(
      calls.indexOf('/operator/production'),
    );
    expect(nativeArgs.find((v) => v.command === 'observer_command')?.args).toMatchObject({
      action: 'start-configured',
    });
  });
  it('keeps game and production unchanged when connection confirmation is cancelled', async () => {
    const calls = setup(undefined, 'preparation', false, true, [], true);
    registerObserverPreparation(() => Promise.resolve(false));
    await productionAction('enter', preparation);
    expect(calls).not.toContain('start_managed_cs2');
    expect(calls).not.toContain('/operator/production');
  });
  it('continues the same entry through verified MulNX launch and attachment without launcher navigation', async () => {
    const calls = setup(undefined, 'preparation', false, true, [
      { preferMulnx: true, running: false, pending: false },
    ]);
    await productionAction('enter', preparation);
    expect(nativeArgs.find((v) => v.command === 'launch_mulnx')?.args).toMatchObject({
      automatic: true,
    });
    expect(nativeArgs.find((v) => v.command === 'attach_external_cs2')?.args).toMatchObject({
      pid: 42,
      created: '134000000000000000',
      expectedRevision: 'one',
    });
    expect(calls).not.toContain('start_managed_cs2');
    expect(calls.indexOf('launch_mulnx')).toBeLessThan(calls.indexOf('attach_external_cs2'));
    expect(calls.indexOf('attach_external_cs2')).toBeLessThan(
      calls.indexOf('/operator/production'),
    );
    expect(calls).toContain('present_production');
    expect(window.location.pathname).toBe('/');
  });
  it('does not attach, enter production or fall back to Steam after a MulNX environment rejection', async () => {
    const calls = setup('mulnx', 'preparation', false, false, [
      { preferMulnx: true, running: false, pending: false },
    ]);
    await expect(productionAction('enter', preparation)).rejects.toThrow('请先关闭冲突程序');
    expect(calls).not.toContain('attach_external_cs2');
    expect(calls).not.toContain('start_managed_cs2');
    expect(calls).not.toContain('/operator/production');
  });
  it('explicit external entry binds the selected identity and never calls managed launch or cleanup', async () => {
    const calls = setup(undefined, 'preparation', false);
    await productionAction('enter', preparation, false, undefined, {
      pid: 42,
      created: '134000000000000000',
    });
    expect(calls).toContain('attach_external_cs2');
    expect(calls).not.toContain('start_managed_cs2');
    expect(calls).not.toContain('finish_managed_cs2');
    expect(nativeArgs.find((v) => v.command === 'attach_external_cs2')?.args).toMatchObject({
      pid: 42,
      created: '134000000000000000',
      expectedRevision: 'one',
    });
    expect(calls.indexOf('attach_external_cs2')).toBeLessThan(
      calls.indexOf('/operator/production'),
    );
    expect(calls.indexOf('/operator/production')).toBeLessThan(calls.indexOf('present_production'));
  });
  it('does not redirect an explicit external selection into an existing Demo session', async () => {
    const calls = setup('trial');
    await expect(
      productionAction('enter', preparation, false, undefined, {
        pid: 42,
        created: '134000000000000000',
      }),
    ).rejects.toThrow('请先结束 Demo');
    expect(calls).not.toContain('enter_demo_test');
    expect(calls).not.toContain('attach_external_cs2');
  });
  it('external presentation failure preserves the instance and provides detach guidance', async () => {
    setup('presentation', 'live', false);
    await expect(
      productionAction('enter', preparation, false, undefined, {
        pid: 42,
        created: '134000000000000000',
      }),
    ).rejects.toThrow('外部游戏已保留');
    expect(nativeArgs.map((v) => v.command)).not.toContain('finish_managed_cs2');
  });

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
    expect(
      controls
        .filter((event) => event.operation === 'task' && event.phase === 'terminal')
        .map((event) => event.evidence.evidence?.result),
    ).toEqual(['cancelled']);
    expect(controls.some((event) => event.phase === 'waiting')).toBe(true);
  });
  it('reads actual live state after an uncertain commit and keeps the newly started game', async () => {
    const calls = setup('network', 'live');
    await expect(productionAction('enter', preparation)).rejects.toThrow(
      '制作已开始，但工作台尚未打开',
    );
    expect(calls.filter((call) => call !== '/debug/control-event').at(-1)).toBe(
      '/local/v1/production',
    );
    expect(calls).not.toContain('finish_managed_cs2');
    const terminal = controls.find(
      (event) => event.operation === 'task' && event.phase === 'terminal',
    );
    expect(terminal?.evidence.evidence).toMatchObject({
      result: 'failed',
      error: { cause: { message: '网络中断' } },
    });
  });
  it('reports auxiliary failure after the workspace is already presented', async () => {
    const calls = setup('assist', 'live', false, true, [], true);
    await expect(productionAction('enter', preparation)).rejects.toThrow(
      '工作台已打开，观战连接或 HUD 准备未完成',
    );
    expect(calls).toContain('present_production');
    expect(calls).not.toContain('finish_managed_cs2');
  });
  it('confirms the existing connection on return and dispatches through the reusable native entry', async () => {
    const calls = setup(undefined, 'live', false, true, [], true);
    const confirm = vi.fn(() => Promise.resolve(true));
    registerObserverPreparation(confirm);
    await productionAction('enter', { ...preparation, mode: 'live' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls).toContain('/local/v1/observer-assist');
    expect(calls).toContain('present_production');
    expect(nativeArgs.find((value) => value.command === 'observer_command')?.args).toMatchObject({
      action: 'start-configured',
    });
  });
  it.each([false, true])(
    'uses the one-entry HUD override only with advertised support (%s)',
    async (supported) => {
      const calls = setup(
        undefined,
        'preparation',
        false,
        true,
        [
          { preferMulnx: true, running: true, pending: false },
          { preferMulnx: true, running: true, pending: false },
        ],
        true,
        supported,
      );
      registerObserverPreparation(() => Promise.resolve({ skipGameHud: true }));
      if (!supported) {
        await expect(productionAction('enter', preparation)).rejects.toThrow('请更新桌面组件');
        expect(calls).not.toContain('start_managed_cs2');
      } else {
        await productionAction('enter', preparation);
        expect(
          nativeArgs.find((value) => value.command === 'observer_command')?.args,
        ).toMatchObject({ action: 'start-configured', skipGameHud: true });
        expect(calls).not.toContain('/operator/observer-assist');
      }
    },
  );
  it('coalesces repeated entry clicks while confirmation is pending', async () => {
    const calls = setup(undefined, 'preparation', false, true, [], true);
    let accept!: (value: boolean) => void;
    registerObserverPreparation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const first = productionAction('enter', preparation);
    const repeated = productionAction('enter', preparation);
    expect(repeated).toBe(first);
    await vi.waitFor(() => expect(accept).toBeDefined());
    accept(true);
    await Promise.all([first, repeated]);
    expect(calls.filter((call) => call === 'start_managed_cs2')).toHaveLength(1);
  });
  it('does not launch after navigation changes during connection confirmation', async () => {
    const calls = setup(undefined, 'preparation', false, true, [], true);
    registerObserverPreparation(() => {
      window.history.pushState(null, '', '/settings');
      return Promise.resolve(true);
    });
    await productionAction('enter', preparation);
    expect(calls).not.toContain('start_managed_cs2');
    expect(calls).not.toContain('observer_command');
    expect(calls).not.toContain('/operator/production');
  });
  it('keeps simultaneous actions separate while linking each native and HTTP child to its root task', async () => {
    setup();
    await Promise.all([
      productionAction('hide', preparation),
      productionAction('hide', preparation),
    ]);
    const starts = controls.filter(
      (event) => event.operation === 'task' && event.phase === 'begin',
    );
    const ends = controls.filter(
      (event) => event.operation === 'task' && event.phase === 'terminal',
    );
    const roots = starts.map((event) => event.evidence.taskId);
    expect(new Set(roots).size).toBe(2);
    expect(ends.map((event) => event.evidence.taskId).sort()).toEqual([...roots].sort());
    expect(ends.every((event) => event.evidence.evidence?.result === 'confirmed')).toBe(true);
    expect(
      requests
        .filter((request) => request.path === '/operator/production')
        .map((request) => request.headers.get('x-mizar-task-id'))
        .sort(),
    ).toEqual([...roots].sort());
    const native = nativeArgs.filter((event) => event.command === 'present_production');
    expect(native.map((event) => event.args?.diagnosticTaskId).sort()).toEqual([...roots].sort());
    expect(new Set(native.map((event) => event.args?.diagnosticOperationId)).size).toBe(2);
  });
});
