// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const values = vi.hoisted(() => ({
  status: {
    qualityPreset: 'high',
    frameRateLimit: 60,
    pending: true,
    running: false,
    message: null,
    phase: 'pending',
  },
}));
vi.mock('../src/preparation/cs2-status', async (original) => ({
  ...(await original<typeof import('../src/preparation/cs2-status')>()),
  useCs2Status: () => ({ status: values.status, phase: undefined, error: '' }),
  useWorkspaceExitStatus: () => null,
}));
import { Cs2Recovery } from '../src/preparation/Cs2Recovery';
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});
it.each([true, false, 'readback-failure'] as const)(
  'confirms recovery only when the Host readback has cleared pending state (pending=%s)',
  async (pending) => {
    const events: {
      operation: string;
      phase: string;
      evidence: { taskId: string; evidence: { result: string } };
    }[] = [];
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
      events.push(JSON.parse(init.body as string) as (typeof events)[number]);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    window.__TAURI_INTERNALS__ = {
      invoke: <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        if (pending === 'readback-failure' && command === 'cs2_config_status')
          return Promise.reject(new Error('Host status unavailable'));
        const result =
          command === 'cs2_config_status'
            ? { ...values.status, pending, phase: pending ? 'pending' : 'idle' }
            : command === 'workspace_exit_status'
              ? { busy: false, stage: '', message: null }
              : undefined;
        return Promise.resolve(result as T);
      },
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <Cs2Recovery production={{ mode: 'preparation', revision: 'one', canEnter: true }} />,
        ),
      );
      const button = [...container.querySelectorAll('button')].find(
        (element) => element.textContent === '恢复配置备份',
      );
      expect(button).toBeDefined();
      await act(async () => {
        button!.click();
        await Promise.resolve();
      });
      const rootStart = events.find(
        (event) => event.operation === 'task' && event.phase === 'begin',
      );
      const terminal = events.find(
        (event) => event.operation === 'task' && event.phase === 'terminal',
      );
      expect(terminal?.evidence.taskId).toBe(rootStart?.evidence.taskId);
      expect(terminal?.evidence.evidence.result).toBe(pending ? 'unconfirmed' : 'confirmed');
      expect(
        calls.find((call) => call.command === 'restore_cs2_backup')?.args?.diagnosticTaskId,
      ).toBe(rootStart?.evidence.taskId);
      expect(calls.map((call) => call.command)).toEqual(
        pending === 'readback-failure'
          ? ['restore_cs2_backup', 'cs2_config_status']
          : ['restore_cs2_backup', 'cs2_config_status', 'workspace_exit_status'],
      );
      expect(container.textContent).toContain(
        pending === 'readback-failure'
          ? '处理结果尚未确认'
          : pending
            ? '处理结果仍待确认'
            : '恢复检查已完成。',
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
