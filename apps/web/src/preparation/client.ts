import { ControlTask } from '../debug/control-task';
import { controlEvidence } from '../debug/control-journal';
import type { Cs2ConfigStatus } from './cs2-status';
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

let entering: Promise<ControlTask['result']> | undefined;
let cancelPendingEntry: (() => void) | undefined;
export function cancelProductionEntry() {
  cancelPendingEntry?.();
}
export function productionAction(
  action: 'enter' | 'hide' | 'finish',
  state: Production,
  preserveSettings = false,
  parentTask?: ControlTask,
  external?: ExternalGameIdentity,
  onChecking?: (checking: boolean) => void,
) {
  if (action !== 'enter')
    return runProductionAction(action, state, preserveSettings, parentTask, external);
  if (entering) return entering;
  entering = runProductionAction(
    action,
    state,
    preserveSettings,
    parentTask,
    external,
    onChecking,
  ).finally(() => {
    entering = undefined;
  });
  return entering;
}
async function runProductionAction(
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
    { ...state, preserveSettings, ...(external ? { external } : {}) },
    parentTask,
  );
  let cancelled = false;
  const entryAbort = new AbortController();
  const cancelEntry = () => {
    cancelled = true;
    entryAbort.abort();
  };
  if (action === 'enter') {
    cancelPendingEntry = cancelEntry;
    window.addEventListener('pagehide', cancelEntry);
    window.addEventListener('popstate', cancelEntry);
  }
  try {
    await performProductionAction(
      action,
      state,
      preserveSettings,
      task,
      external,
      () => cancelled,
      entryAbort.signal,
      onChecking,
    );
    return task.result;
  } catch (error) {
    task.fail(error);
    throw error;
  } finally {
    entryAbort.abort();
    if (cancelPendingEntry === cancelEntry) cancelPendingEntry = undefined;
    window.removeEventListener('pagehide', cancelEntry);
    window.removeEventListener('popstate', cancelEntry);
  }
}
async function performProductionAction(
  action: 'enter' | 'hide' | 'finish',
  state: Production,
  preserveSettings: boolean,
  task: ControlTask,
  external: ExternalGameIdentity | undefined,
  cancelled: () => boolean,
  entrySignal: AbortSignal,
  onChecking?: (checking: boolean) => void,
) {
  const entryLocation = window.location.href;
  const entryStillCurrent = async () => {
    if (cancelled() || window.location.href !== entryLocation) return false;
    const current = await fetch('/local/v1/production', {
      headers: task.headers(),
      cache: 'no-store',
      signal: AbortSignal.any([entrySignal, AbortSignal.timeout(5000)]),
    })
      .then((response) => (response.ok ? (response.json() as Promise<Production>) : null))
      .catch(() => null);
    return Boolean(
      current &&
      current.revision === state.revision &&
      current.mode === state.mode &&
      !cancelled() &&
      window.location.href === entryLocation,
    );
  };
  controlEvidence('production_action', 'dispatch', {
    taskId: task.taskId,
    trigger: task.trigger,
    action,
    nativeAvailable: Boolean(window.__TAURI_INTERNALS__),
    mode: state.mode,
    expectedRevision: state.revision,
    page: window.location.pathname,
  });
  if (window.__TAURI_INTERNALS__ && action === 'enter' && state.mode === 'preparation') {
    onChecking?.(true);
    try {
      try {
        const response = await fetch('/operator/updates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...task.headers() },
          body: JSON.stringify({ action: 'entry-check' }),
          signal: AbortSignal.any([entrySignal, AbortSignal.timeout(40_000)]),
        });
        if (response.ok) {
          const updates = (await response.json()) as {
            automatic?: boolean;
            notificationSafe?: boolean;
            notificationPending?: boolean;
            mulnxNotificationPending?: boolean;
            candidate?: { version: string; notes: string } | null;
            mulnx?: { latest: string | null; notificationIdentity: string | null } | null;
          };
          if (
            updates.automatic &&
            updates.notificationSafe &&
            (updates.notificationPending || updates.mulnxNotificationPending)
          ) {
            const proceed = await new Promise<boolean>((resolve) => {
              if (entrySignal.aborted) {
                resolve(false);
                return;
              }
              const request = { updates, signal: entrySignal, resolve, handled: false };
              window.dispatchEvent(new CustomEvent('mizar:entry-update', { detail: request }));
              if (!request.handled) resolve(false);
            });
            if (!proceed) {
              task.finish('cancelled', { reason: 'update_selected' });
              return;
            }
          }
        }
      } catch {
        /* A failed or timed-out check does not block a verified local installation. */
      }
      if (cancelled() || window.location.href !== entryLocation) {
        task.finish('cancelled', { reason: 'navigation_changed' });
        return;
      }
      if (!(await entryStillCurrent())) {
        task.finish('cancelled', { reason: 'production_changed' });
        return;
      }
    } finally {
      onChecking?.(false);
    }
  }
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
      else {
        if (!trial.requestId) throw new Error('试播状态未确认，请刷新后重试。');
        if (
          !(await enterDemoTest(
            trial.requestId,
            task,
            () => window.location.href === entryLocation,
          ))
        ) {
          task.finish('cancelled', { reason: 'demo_entry_changed' });
          return;
        }
      }
      task.finish('confirmed', { confirmation: 'host_demo_command_ack', trial });
      return;
    }
  }
  if (
    action === 'enter' &&
    !(await checkObsBeforeLaunch(
      false,
      task,
      state.mode === 'preparation' ? { revision: state.revision, signal: entrySignal } : undefined,
    ))
  ) {
    task.finish('blocked', { reason: 'preflight_requires_attention' });
    return;
  }
  const launch =
    action === 'enter' && window.__TAURI_INTERNALS__
      ? await desktopInvoke<{
          preferMulnx?: boolean;
          mulnxLaunchResumable?: boolean;
          running: boolean;
          pending: boolean;
          observerHudPending?: boolean;
        }>('cs2_config_status')
      : null;
  if (action === 'enter' && (cancelled() || window.location.href !== entryLocation)) {
    task.finish('cancelled', { reason: 'navigation_changed' });
    return;
  }
  if (action === 'enter' && window.__TAURI_INTERNALS__ && !(await entryStillCurrent())) {
    task.finish('cancelled', { reason: 'production_changed' });
    return;
  }
  let newlyStarted = false;
  let borrowed = Boolean(external);
  let launchedMulnx = false;
  const selectedExternal = external;
  if (action === 'enter' && window.__TAURI_INTERNALS__) {
    if (!external) {
      if (launch?.mulnxLaunchResumable) {
        const result = await desktopInvoke<{ result?: string }>(
          'launch_mulnx',
          { resumeOnly: true },
          task,
        );
        if (result?.result === 'not-found')
          throw new Error('启动请求已结束，请检查游戏状态后重新进入工作台。');
        launchedMulnx = true;
        if (cancelled() || window.location.href !== entryLocation) {
          task.finish('cancelled', { reason: 'navigation_changed' });
          return;
        }
      } else if (launch?.preferMulnx && !launch.running && !launch.pending) {
        await desktopInvoke<ExternalGameIdentity>(
          'launch_mulnx',
          { automatic: true, ...(preserveSettings ? { preserveSettings: true } : {}) },
          task,
        );
        launchedMulnx = true;
        if (cancelled() || window.location.href !== entryLocation) {
          task.finish('cancelled', { reason: 'navigation_changed' });
          return;
        }
      }
    }
    if (launchedMulnx && !(await entryStillCurrent())) {
      task.finish('cancelled', { reason: 'production_changed' });
      return;
    }
    newlyStarted = await desktopInvoke<boolean>(
      selectedExternal ? 'attach_external_cs2' : 'start_managed_cs2',
      selectedExternal
        ? { ...selectedExternal, expectedRevision: state.revision }
        : preserveSettings && !launchedMulnx
          ? { preserveSettings: true }
          : undefined,
      task,
    );
    let gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
    borrowed = gameStatus.borrowed ?? borrowed;
    // Preserve this one entry intent while the native command lock is free.
    // Recovery/cancel remains available; navigation cancels only entry intent.
    const waitStarted = Date.now();
    while (!gameStatus.running) {
      if (Date.now() - waitStarted >= 60000)
        throw new Error('CS2 启动尚未确认，请检查游戏状态后重试。');
      if (
        (!gameStatus.busy && !gameStatus.pending) ||
        cancelled() ||
        window.location.href !== entryLocation
      ) {
        task.finish(
          cancelled() || window.location.href !== entryLocation ? 'cancelled' : 'blocked',
          {
            reason:
              cancelled() || window.location.href !== entryLocation
                ? 'navigation_changed'
                : 'cs2_not_running',
            gameStatus,
          },
        );
        return;
      }
      task.event('waiting', { reason: 'steam_startup', gameStatus });
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (cancelled() || window.location.href !== entryLocation) {
        task.finish('cancelled', { reason: 'navigation_changed' });
        return;
      }
      gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
    }
  }
  if (action === 'enter' && (cancelled() || window.location.href !== entryLocation)) {
    task.finish('cancelled', { reason: 'navigation_changed' });
    return;
  }
  if (
    action === 'enter' &&
    window.__TAURI_INTERNALS__ &&
    !external &&
    state.mode === 'preparation'
  ) {
    await desktopInvoke('begin_managed_camera', { expectedRevision: state.revision }, task);
    if (cancelled() || window.location.href !== entryLocation) {
      await desktopInvoke('cancel_managed_camera', undefined, task);
      task.finish('cancelled', { reason: 'navigation_changed' });
      return;
    }
  }
  let presented = false;
  try {
    await command('/operator/production', { action, expectedRevision: state.revision }, task);
    if (action === 'enter' && (cancelled() || window.location.href !== entryLocation)) {
      if (window.__TAURI_INTERNALS__ && !external && state.mode === 'preparation')
        await desktopInvoke('cancel_managed_camera', undefined, task);
      task.finish('cancelled', { reason: 'navigation_changed' });
      return;
    }
    if (window.__TAURI_INTERNALS__) {
      await desktopInvoke('present_production', { live: action === 'enter' }, task);
      presented = true;
    } else window.location.assign(action === 'enter' ? '/workspace' : '/');
    task.finish('confirmed', { confirmation: 'production_command_ack_and_presentation', action });
  } catch (reason) {
    if (action !== 'enter' || !window.__TAURI_INTERNALS__) throw reason;
    if (presented)
      throw new Error(
        `工作台已打开，观战连接或 HUD 准备未完成。请在游戏与观战设置核对本场连接和 HUD 状态后重试。${reason instanceof Error ? reason.message : '操作未完成。'}`,
        { cause: reason },
      );
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
