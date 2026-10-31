import { ControlTask } from '../debug/control-task';
import type { DemoTestView } from './demo-test';
import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';
import { prepareObs } from '../workspace/obs-preparation';

export function useLocalReadWithTime<T>(path: string | null, interval = 2000, refresh = 0) {
  const [value, setValue] = useState<{
    value: T | null;
    updatedAt: number | null;
    status: 'loading' | 'ready' | 'unavailable';
  }>({
    value: null,
    updatedAt: null,
    status: 'loading',
  });
  useEffect(() => {
    if (path === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('unavailable');
        const next = (await response.json()) as T;
        if (active) setValue({ value: next, updatedAt: Date.now(), status: 'ready' });
      } catch {
        if (active) setValue({ value: null, updatedAt: null, status: 'unavailable' });
      } finally {
        if (active) timer = setTimeout(() => void poll(), interval);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, interval, refresh]);
  return value;
}
export function useLocalRead<T>(path: string | null, interval = 2000, refresh = 0) {
  return useLocalReadWithTime<T>(path, interval, refresh).value;
}
export async function command(
  path: string,
  body: unknown = {},
  task?: ControlTask,
  timeoutMs = 15000,
) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...task?.headers() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new Error(result.message ?? '操作未完成，请刷新后重试。');
  return result;
}
export async function enterDemoTest(
  requestId: string,
  task?: ControlTask,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<boolean> {
  const location = window.location.href;
  const intentId = crypto.randomUUID();
  const current = () => !signal?.aborted && isCurrent() && window.location.href === location;
  const cancel = () => {
    void desktopInvoke('cancel_demo_entry', { intentId }).catch(() => {});
  };
  if (!current()) return false;
  window.addEventListener('pagehide', cancel);
  window.addEventListener('popstate', cancel);
  signal?.addEventListener('abort', cancel);
  try {
    await desktopInvoke('begin_demo_entry', { intentId }, task);
    if (!current()) return false;
    const camera = await desktopInvoke<boolean>('enter_demo_test', { requestId }, task);
    if (!current()) return false;
    await desktopInvoke('present_demo_test', { requestId, expectedUrl: location, intentId }, task);
    if (!current()) return false;
    if (camera) {
      const response = await fetch('/local/v1/demo-test', {
        headers: task?.headers() ?? {},
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('试播状态未确认，请重试。');
      const trial = (await response.json()) as DemoTestView;
      if (!current() || !trial.active || trial.phase !== 'playing' || trial.requestId !== requestId)
        return false;
      await command('/operator/orchestration', { action: 'connect' }, task);
      if (!current()) return false;
    }
    return true;
  } finally {
    window.removeEventListener('pagehide', cancel);
    window.removeEventListener('popstate', cancel);
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

export type Tool = 'hud' | 'bp' | 'diagnostics';
const toolPaths = {
  hud: '/operator/hud',
  bp: '/matches#match-bp',
  diagnostics: '/debug',
};
export async function openTool(tool: Tool, presetId?: string) {
  if (window.__TAURI_INTERNALS__) {
    if (tool === 'bp') await desktopInvoke('open_main', { path: toolPaths[tool] });
    else await desktopInvoke('open_tool', { tool, presetId });
  } else {
    const path =
      tool === 'hud' && presetId
        ? `${toolPaths.hud}?preset=${encodeURIComponent(presetId)}`
        : toolPaths[tool];
    if (tool === 'hud') {
      const editor = window.open('', 'mizar-hud');
      if (!editor) throw new Error('请允许打开 HUD 编辑器窗口。');
      if (editor.location.pathname === '/operator/hud') {
        if (presetId)
          editor.dispatchEvent(new CustomEvent('mizar:hud-select-preset', { detail: presetId }));
        editor.focus();
      } else editor.location.assign(path);
    } else window.open(path, `mizar-${tool}`);
  }
}
export async function openRivalHubAuthorization(url: string, popup?: Window | null) {
  if (window.__TAURI_INTERNALS__) await desktopInvoke('open_rivalhub_authorization', { url });
  else if (popup && !popup.closed) popup.location.replace(url);
  else window.open(url, 'mizar-rivalhub');
}
export interface Production {
  mode: 'preparation' | 'live' | 'hidden';
  revision: string;
  canEnter: boolean;
}
export async function checkObsBeforeLaunch(
  requireStoppedOutput = false,
  task?: ControlTask,
  entry?: { revision: string; signal: AbortSignal },
) {
  // Installation is checkable before launch; fresh telemetry is not.
  if (window.__TAURI_INTERNALS__) {
    const gsi = await desktopInvoke<{ installed: boolean; conflict: boolean }>(
      'gsi_status',
      undefined,
      task,
    );
    if (!gsi.installed || gsi.conflict) {
      window.location.assign('/settings?tab=gsi&prepare=1');
      return false;
    }
  }
  // A fresh UI readiness check; Companion still owns the production lifecycle.
  const readObs = () =>
    fetch('/local/v1/obs', {
      headers: task?.headers() ?? {},
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as {
              connection: string;
              findings: readonly unknown[];
              streaming?: boolean;
              recording?: boolean;
            })
          : null,
      )
      .catch(() => null);
  let obs = await readObs();
  if (entry && obs?.connection === 'connected' && !obs.streaming && !obs.recording) {
    await prepareObs(entry.revision, entry.signal);
    obs = await readObs();
  }
  if (obs?.connection !== 'connected' || obs.findings.length > 0) {
    window.location.assign('/settings?tab=obs&prepare=1');
    return false;
  }
  if (requireStoppedOutput && obs.streaming !== false)
    throw new Error('请先在 OBS 停止推流并确认状态，再开始 Demo 试播。');
  return true;
}

export type ExternalGameIdentity = { pid: number; created: string };

type PreparationStatus = {
  id: string;
  running: boolean;
  cancelled: boolean;
  entered: boolean;
  message: string;
};

export async function cancelProductionEntry() {
  if (!window.__TAURI_INTERNALS__) return;
  const status = await desktopInvoke<PreparationStatus | null>('preparation_status');
  if (status) await desktopInvoke('preparation_cancel', { preparationId: status.id });
}
export async function retryPendingPreparation() {
  const status = await desktopInvoke<PreparationStatus | null>('preparation_status');
  if (!status) throw new Error('本次准备任务不可用，请重新进入工作台。');
  await desktopInvoke('preparation_retry', { preparationId: status.id });
}

export async function productionAction(
  action: 'enter' | 'hide' | 'finish',
  state: Production,
  preserveSettings = false,
  parentTask?: ControlTask,
  external?: ExternalGameIdentity,
  onChecking?: (checking: boolean) => void,
) {
  const task = new ControlTask(
    `production_${action}`,
    'user',
    { ...state, preserveSettings, external },
    parentTask,
  );
  try {
    if (window.__TAURI_INTERNALS__ && action === 'finish') {
      await desktopInvoke('finish_workspace', undefined, task);
    } else if (window.__TAURI_INTERNALS__ && action === 'enter' && state.mode === 'preparation') {
      onChecking?.(true);
      try {
        const response = await fetch('/operator/updates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...task.headers() },
          body: JSON.stringify({ action: 'entry-check' }),
          signal: AbortSignal.timeout(40_000),
        });
        if (response.ok) {
          const updates = await response.json();
          if (
            updates.automatic &&
            updates.notificationSafe &&
            (updates.notificationPending || updates.mulnxNotificationPending)
          ) {
            const abort = new AbortController();
            const proceed = await new Promise<boolean>((resolve) => {
              const request = { updates, signal: abort.signal, resolve, handled: false };
              window.dispatchEvent(new CustomEvent('mizar:entry-update', { detail: request }));
              if (!request.handled) resolve(false);
            });
            if (!proceed) {
              task.finish('cancelled', { reason: 'update_selected' });
              return task.result;
            }
          }
        }
      } catch {
        /* Update checks do not block a local installation. */
      } finally {
        onChecking?.(false);
      }
      const response = await fetch('/local/v1/demo-test', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('试播状态未确认，请检查本地服务后重试。');
      const trial = (await response.json()) as DemoTestView;
      if (trial.active) {
        if (external) throw new Error('请先结束 Demo 试播，再选择外部游戏。');
        if (!trial.requestId || !(await enterDemoTest(trial.requestId, task))) {
          task.finish('cancelled', { reason: 'demo_entry_changed' });
          return task.result;
        }
      } else {
        await desktopInvoke(
          'preparation_start',
          {
            preparationId: crypto.randomUUID(),
            expectedRevision: state.revision,
            preserveSettings,
            externalPid: external?.pid ?? null,
            externalCreated: external?.created ?? null,
          },
          task,
        );
      }
    } else {
      if (
        !window.__TAURI_INTERNALS__ &&
        action === 'enter' &&
        !(await checkObsBeforeLaunch(
          false,
          task,
          state.mode === 'preparation'
            ? { revision: state.revision, signal: AbortSignal.timeout(40_000) }
            : undefined,
        ))
      ) {
        task.finish('blocked', { reason: 'preflight_requires_attention' });
        return task.result;
      }
      await command('/operator/production', { action, expectedRevision: state.revision }, task);
      if (window.__TAURI_INTERNALS__)
        await desktopInvoke('present_production', { live: action === 'enter' }, task);
      else window.location.assign(action === 'enter' ? '/workspace' : '/');
    }
    task.finish('confirmed', {
      confirmation:
        action === 'enter' && state.mode === 'preparation'
          ? 'preparation_accepted'
          : 'production_command_ack',
    });
    return task.result;
  } catch (error) {
    task.fail(error);
    throw error;
  }
}
