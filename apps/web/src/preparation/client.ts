import { flushObserverPreparation } from './observer-preparation';
import { ControlTask } from '../debug/control-task';
import { controlEvidence } from '../debug/control-journal';
import type { Cs2ConfigStatus } from './cs2-status';
import type { DemoTestView } from './demo-test';
import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';

export function useLocalReadWithTime<T>(path: string | null, interval = 2000, refresh = 0) {
  const [value, setValue] = useState<{ value: T | null; updatedAt: number | null }>({
    value: null,
    updatedAt: null,
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
        if (active) setValue({ value: next, updatedAt: Date.now() });
      } catch {
        if (active) setValue({ value: null, updatedAt: null });
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
export async function command(path: string, body: unknown = {}, task?: ControlTask) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...task?.headers() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new Error(result.message ?? '操作未完成，请刷新后重试。');
  return result;
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
export async function checkObsBeforeLaunch(requireStoppedOutput = false, task?: ControlTask) {
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
  const obs = await fetch('/local/v1/obs', {
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
          })
        : null,
    )
    .catch(() => null);
  if (obs?.connection !== 'connected' || obs.findings.length > 0) {
    window.location.assign('/settings?tab=obs&prepare=1');
    return false;
  }
  if (requireStoppedOutput && obs.streaming !== false)
    throw new Error('请先在 OBS 停止推流并确认状态，再开始 Demo 试播。');
  return true;
}

export type ExternalGameIdentity = { pid: number; created: string };

export async function productionAction(
  action: 'enter' | 'hide' | 'finish',
  state: Production,
  preserveSettings = false,
  parentTask?: ControlTask,
  external?: ExternalGameIdentity,
) {
  const task = new ControlTask(
    `production_${action}`,
    'user',
    { ...state, preserveSettings, ...(external ? { external } : {}) },
    parentTask,
  );
  try {
    await performProductionAction(action, state, preserveSettings, task, external);
    return task.result;
  } catch (error) {
    task.fail(error);
    throw error;
  }
}
async function performProductionAction(
  action: 'enter' | 'hide' | 'finish',
  state: Production,
  preserveSettings: boolean,
  task: ControlTask,
  external?: ExternalGameIdentity,
) {
  controlEvidence('production_action', 'dispatch', {
    taskId: task.taskId,
    trigger: task.trigger,
    action,
    nativeAvailable: Boolean(window.__TAURI_INTERNALS__),
    mode: state.mode,
    expectedRevision: state.revision,
    page: window.location.pathname,
  });
  if (window.__TAURI_INTERNALS__ && action === 'finish') {
    await desktopInvoke('finish_workspace', undefined, task);
    task.finish('confirmed', { confirmation: 'host_finish_workspace_ack' });
    return;
  }
  if (window.__TAURI_INTERNALS__ && action !== 'hide') {
    const response = await fetch('/local/v1/demo-test', {
      headers: task.headers(),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('试播状态未确认，请检查本地服务后重试。');
    const trial = (await response.json()) as DemoTestView;
    if (trial.active) {
      if (external) throw new Error('请先结束 Demo 试播，再选择外部游戏。');
      if (action === 'finish')
        await desktopInvoke('finish_demo_test', { requestId: trial.requestId }, task);
      else await desktopInvoke('enter_demo_test', { requestId: trial.requestId }, task);
      task.finish('confirmed', { confirmation: 'host_demo_command_ack', trial });
      return;
    }
  }
  const entryLocation = window.location.href;
  if (action === 'enter' && !(await checkObsBeforeLaunch(false, task))) {
    task.finish('blocked', { reason: 'preflight_requires_attention' });
    return;
  }
  const observerEnabled = action === 'enter' && (await flushObserverPreparation());
  let newlyStarted = false;
  let borrowed = Boolean(external);
  let selectedExternal = external;
  if (action === 'enter' && window.__TAURI_INTERNALS__) {
    if (!external) {
      const launch = await desktopInvoke<{
        preferMulnx?: boolean;
        running: boolean;
        pending: boolean;
      }>('cs2_config_status');
      if ((launch.preferMulnx || observerEnabled) && !launch.running && !launch.pending) {
        selectedExternal = await desktopInvoke<ExternalGameIdentity>(
          'launch_mulnx',
          { automatic: true },
          task,
        );
        if (window.location.href !== entryLocation) {
          task.finish('cancelled', { reason: 'navigation_changed', game: selectedExternal });
          return;
        }
        borrowed = true;
      }
    }
    newlyStarted = await desktopInvoke<boolean>(
      selectedExternal ? 'attach_external_cs2' : 'start_managed_cs2',
      selectedExternal
        ? { ...selectedExternal, expectedRevision: state.revision }
        : preserveSettings
          ? { preserveSettings: true }
          : undefined,
      task,
    );
    let gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
    borrowed = gameStatus.borrowed ?? borrowed;
    // Preserve this one entry intent while the native command lock is free.
    // Recovery/cancel remains available; navigation cancels only entry intent.
    while (!gameStatus.running) {
      if ((!gameStatus.busy && !gameStatus.pending) || window.location.href !== entryLocation) {
        task.finish(window.location.href !== entryLocation ? 'cancelled' : 'blocked', {
          reason: window.location.href !== entryLocation ? 'navigation_changed' : 'cs2_not_running',
          gameStatus,
        });
        return;
      }
      task.event('waiting', { reason: 'steam_startup', gameStatus });
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (window.location.href !== entryLocation) {
        task.finish('cancelled', { reason: 'navigation_changed' });
        return;
      }
      gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
    }
  }
  if (action === 'enter' && window.location.href !== entryLocation) {
    task.finish('cancelled', { reason: 'navigation_changed' });
    return;
  }
  try {
    await command('/operator/production', { action, expectedRevision: state.revision }, task);
    if (window.__TAURI_INTERNALS__) {
      await desktopInvoke('present_production', { live: action === 'enter' }, task);
      if (observerEnabled)
        await desktopInvoke('observer_command', { action: 'start-configured' }, task);
    } else window.location.assign(action === 'enter' ? '/workspace' : '/');
    task.finish('confirmed', { confirmation: 'production_command_ack_and_presentation', action });
  } catch (reason) {
    if (action !== 'enter' || !window.__TAURI_INTERNALS__) throw reason;
    const actual = await fetch('/local/v1/production', {
      headers: task.headers(),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
      .then(async (response) => (response.ok ? ((await response.json()) as Production) : null))
      .catch(() => null);
    const detail = reason instanceof Error ? reason.message : '操作未完成。';
    const game = borrowed ? '外部游戏已保留' : newlyStarted ? 'CS2 已启动' : '受管理的 CS2 已保留';
    throw new Error(
      `${game}，${actual?.mode === 'live' ? '制作已开始，但工作台尚未打开' : actual?.mode === 'preparation' ? '工作台尚未进入' : '制作状态待确认'}。重试打开工作台，或${borrowed ? '退出工作台解除借用，外部游戏保持运行' : '退出本次游戏并恢复设置'}。${detail}`,
      { cause: reason },
    );
  }
}
