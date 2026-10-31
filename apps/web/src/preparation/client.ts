import { ControlTask } from '../debug/control-task';
import { controlEvidence } from '../debug/control-journal';
import type { Cs2ConfigStatus } from './cs2-status';
import type { DemoTestView } from './demo-test';
import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';
import { prepareObs } from '../workspace/obs-preparation';
import { obsCommand, type ObsStatus } from '../workspace/obs-client';

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

type GsiStatus = {
  detected: boolean;
  installed: boolean;
  conflict: boolean;
  readFailed: boolean;
  issues?: readonly { message: string }[];
};

async function readObsForEntry(signal: AbortSignal): Promise<ObsStatus | null> {
  return fetch('/local/v1/obs', {
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
  })
    .then((response) => (response.ok ? (response.json() as Promise<ObsStatus>) : null))
    .catch(() => null);
}

async function ensureEntryObs(signal: AbortSignal) {
  let obs = await readObsForEntry(signal);
  if (signal.aborted) throw new Error('启动已取消。');
  if (obs?.connection === 'connected') return;
  if (obs?.connection === 'password_required' || obs?.connection === 'invalid_password')
    throw new Error('OBS WebSocket 密码未配置或不正确，请核对后重试。');
  await obsCommand('open', {}, signal);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !signal.aborted) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    obs = await readObsForEntry(signal);
    if (obs?.connection === 'connected') return;
    if (obs?.connection === 'password_required' || obs?.connection === 'invalid_password')
      throw new Error('OBS WebSocket 密码未配置或不正确，请核对后重试。');
  }
  throw new Error(signal.aborted ? '启动已取消。' : 'OBS 未能连接，请检查 OBS 状态后重试。');
}

function gsiProblem(status: GsiStatus): string | null {
  if (status.readFailed || !status.detected)
    return status.issues?.[0]?.message ?? '无法确认 CS2 安装或 GSI 配置，请检查后重试。';
  return null;
}

async function entryCommand<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(40_000)])
      : AbortSignal.timeout(40_000),
  });
  const value = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(value.message ?? '自动准备未完成，请重试。');
  return value;
}

async function restoreEntryVideo(transactionId: string) {
  await entryCommand('/operator/obs/video-restore', { transactionId });
}

let entering: Promise<ControlTask['result']> | undefined;
let cancelPendingEntry: (() => void) | undefined;
let lastPreparation: {
  id: string;
  since: number | null;
  obs: boolean;
  gsi: boolean;
  capture: boolean;
  camera: boolean;
  cameraUncertain: boolean;
} | null = null;
export function cancelProductionEntry() {
  cancelPendingEntry?.();
}
let retryingPreparation: Promise<void> | undefined;
export function retryPendingPreparation(): Promise<void> {
  if (retryingPreparation) return retryingPreparation;
  retryingPreparation = (async () => {
    const production = await fetch('/local/v1/production', { cache: 'no-store' }).then(
      (r) => r.json() as Promise<Production>,
    );
    if (production.mode === 'preparation') {
      await productionAction('enter', production);
      return;
    }
    const entry = lastPreparation;
    if (!entry) throw new Error('本次准备记录不可用，请返回准备中心。');
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      lastPreparation = null;
      void desktopInvoke('cancel_cs2_preparation', { preparationId: entry.id }).catch(() => {});
    };
    cancelPendingEntry = cancel;
    const errors: string[] = [];
    const check = async () => {
      if (controller.signal.aborted || lastPreparation !== entry) throw new Error('准备已取消。');
      const game = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status');
      if (!game.running || game.preparationId !== entry.id)
        throw new Error('本次受管游戏已变化，请重新进入。');
      const now = await fetch('/local/v1/production', { cache: 'no-store' }).then(
        (r) => r.json() as Promise<Production>,
      );
      if (now.revision !== production.revision || now.mode !== production.mode)
        throw new Error('制作状态已变化，请重试。');
    };
    const step = async (run: () => Promise<void>) => {
      try {
        await check();
        await run();
        await check();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        errors.push(error instanceof Error ? error.message : '准备未完成。');
      }
    };
    try {
      if (!entry.obs)
        await step(async () => {
          const obs = await readObsForEntry(controller.signal);
          if (obs?.connection === 'connected' && obs.sceneAligned === false)
            throw new Error('OBS 场景已由操作者接管，未自动切换。');
          await ensureEntryObs(controller.signal);
          await entryCommand(
            '/operator/obs/video-preflight',
            { expectedRevision: production.revision },
            controller.signal,
          );
          await entryCommand(
            '/operator/obs/video-prepare',
            { expectedRevision: production.revision },
            controller.signal,
          );
          await prepareObs(production.revision, controller.signal, entry.id);
          entry.obs = true;
        });
      if (!entry.gsi)
        await step(async () => {
          const current = await desktopInvoke<GsiStatus>('gsi_status');
          if (gsiProblem(current)) throw new Error(gsiProblem(current)!);
          if (current.installed && !current.conflict) {
            entry.gsi = true;
            return;
          }
          const result = await desktopInvoke<GsiStatus>('ensure_gsi', { preparationId: entry.id });
          if (gsiProblem(result) || !result.installed || result.conflict)
            throw new Error(gsiProblem(result) ?? 'GSI 自动配置未完成。');
          entry.gsi = true;
        });
      if (!entry.capture)
        await step(async () => {
          const warmup = await entryCommand<{ transactionId: string; startedAt: number }>(
            '/operator/obs/capture-warmup',
            { expectedRevision: production.revision, preparationId: entry.id },
            controller.signal,
          );
          try {
            const deadline = warmup.startedAt + 60_000;
            while (Date.now() < deadline) {
              await check();
              const result = await entryCommand<{ state: string; reason: string | null }>(
                '/operator/obs/capture-initialization',
                {
                  expectedRevision: production.revision,
                  since: warmup.startedAt,
                  transactionId: warmup.transactionId,
                },
                controller.signal,
              );
              if (result.state === 'initialized') {
                entry.capture = true;
                break;
              }
              if (result.state === 'failed' || result.reason === 'source_inactive')
                throw new Error('OBS 游戏捕获未确认，请检查后重试。');
              await new Promise<void>((resolve) => setTimeout(resolve, 1000));
            }
            if (!entry.capture) throw new Error('OBS 游戏捕获未确认，请检查后重试。');
          } finally {
            await entryCommand('/operator/obs/capture-warmup-release', {
              transactionId: warmup.transactionId,
            });
          }
        });
      if (!entry.camera)
        await step(async () => {
          if (entry.cameraUncertain) throw new Error('上次运镜准备结果未确认，请先核对当前状态。');
          entry.cameraUncertain = true;
          await desktopInvoke('begin_managed_camera', {
            expectedRevision: production.revision,
            preparationId: entry.id,
          });
          entry.camera = true;
          entry.cameraUncertain = false;
        });
      await desktopInvoke('workbench_message', { action: 'status', message: errors.join('；') });
    } finally {
      if (cancelPendingEntry === cancel) cancelPendingEntry = undefined;
    }
  })().finally(() => {
    retryingPreparation = undefined;
  });
  return retryingPreparation;
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
  let videoTransactionId: string | null = null;
  const warnings: string[] = [];
  let cancelNativeEntry: (() => void) | undefined;
  const cancelEntry = () => {
    cancelled = true;
    entryAbort.abort();
    cancelNativeEntry?.();
  };
  if (action === 'enter') {
    cancelPendingEntry = cancelEntry;
    window.addEventListener('pagehide', cancelEntry);
    window.addEventListener('popstate', cancelEntry);
  }
  try {
    if (action === 'enter' && window.__TAURI_INTERNALS__ && state.mode === 'preparation') {
      const key = `mizar:workspace-entry:${state.revision}`;
      let intent: { id: string; since: number | null } | null = null;
      try {
        intent = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      } catch {
        /* discard invalid intent */
      }
      if (!intent || typeof intent.id !== 'string')
        intent = { id: crypto.randomUUID(), since: null };
      if (!lastPreparation || lastPreparation.id !== intent.id)
        lastPreparation = {
          ...intent,
          obs: false,
          gsi: false,
          capture: false,
          camera: false,
          cameraUncertain: false,
        };
      sessionStorage.setItem(key, JSON.stringify(intent));
      await desktopInvoke('present_workbench_panels', { preparationId: intent.id }, task);
      void desktopInvoke('workbench_message', {
        action: 'status',
        message: '正在准备游戏和 OBS…',
      }).catch(() => {});
    }
    await performProductionAction(
      action,
      state,
      preserveSettings,
      task,
      external,
      () => cancelled,
      entryAbort.signal,
      onChecking,
      (id) => {
        videoTransactionId = id;
      },
      (cancel) => {
        cancelNativeEntry = cancel;
      },
      (message) => {
        warnings.push(message);
        void desktopInvoke('workbench_message', {
          action: 'status',
          message: warnings.join('；'),
        }).catch(() => {});
      },
    );
    if (action === 'enter' && window.__TAURI_INTERNALS__ && warnings.length === 0)
      void desktopInvoke('workbench_message', { action: 'status', message: '' }).catch(() => {});
    if (action === 'enter' && task.result !== 'confirmed' && videoTransactionId) {
      const current = await fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<Production>) : null))
        .catch(() => null);
      if (current?.mode === 'preparation') await restoreEntryVideo(videoTransactionId);
    }
    return task.result;
  } catch (error) {
    let failure = error;
    if (action === 'enter' && videoTransactionId) {
      const current = await fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<Production>) : null))
        .catch(() => null);
      if (current?.mode === 'preparation') {
        try {
          await restoreEntryVideo(videoTransactionId);
        } catch (restoreError) {
          failure = new Error(
            `${error instanceof Error ? error.message : '启动未完成。'} OBS 视频设置恢复未确认：${restoreError instanceof Error ? restoreError.message : '请重试。'}`,
            { cause: error },
          );
        }
      }
    }
    task.fail(failure);
    if (action === 'enter' && window.__TAURI_INTERNALS__)
      void desktopInvoke('workbench_message', {
        action: 'status',
        message: failure instanceof Error ? failure.message : '准备未完成。',
      }).catch(() => {});
    throw failure;
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
  onVideoPrepared?: (id: string | null) => void,
  onNativeEntry?: (cancel: () => void) => void,
  onWarning?: (message: string) => void,
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
  if (window.__TAURI_INTERNALS__ && action === 'enter' && state.mode === 'hidden') {
    await command('/operator/production', { action, expectedRevision: state.revision }, task);
    await desktopInvoke('present_production', { live: true }, task);
    task.finish('confirmed', { confirmation: 'production_command_ack_and_presentation', action });
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
  let entry: { id: string; since: number | null } | undefined;
  let replacement: { target: (ExternalGameIdentity & { managed: boolean }) | null } | undefined;
  if (window.__TAURI_INTERNALS__ && action === 'enter' && state.mode === 'preparation') {
    const storageKey = `mizar:workspace-entry:${state.revision}`;
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as typeof entry;
      if (stored && typeof stored.id === 'string') entry = stored;
    } catch {
      /* A damaged intent is never treated as proof of ownership. */
    }
    entry ??= { id: crypto.randomUUID(), since: null };
    sessionStorage.setItem(storageKey, JSON.stringify(entry));
    const preparationId = entry.id;
    onNativeEntry?.(() => {
      sessionStorage.removeItem(storageKey);
      lastPreparation = null;
      void desktopInvoke('cancel_cs2_preparation', { preparationId }, task).catch(() => {});
    });
    const current = async () => {
      if (!(await entryStillCurrent())) throw new Error('启动已取消或制作状态已变化，请重试。');
    };
    const launchStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
    const resuming =
      launchStatus.preparationId === entry.id &&
      (launchStatus.running || launchStatus.pending || launchStatus.mulnxLaunchResumable);
    if (!resuming)
      replacement = await desktopInvoke<typeof replacement>(
        'preflight_cs2_replacement',
        undefined,
        task,
      );
    await current();
    if (!resuming) {
      const target = replacement?.target ?? null;
      if (
        external &&
        (!target || external.pid !== target.pid || external.created !== target.created)
      )
        throw new Error('所选游戏实例已变化，未关闭游戏；请重试。');
      const reused = await desktopInvoke<boolean>(
        'replace_external_cs2',
        {
          expectedPid: target?.pid ?? null,
          expectedCreated: target?.created ?? null,
          expectedRevision: state.revision,
          preparationId: entry.id,
        },
        task,
      );
      if (!reused) {
        entry.since = Date.now();
        if (lastPreparation?.id === entry.id) lastPreparation.since = entry.since;
        sessionStorage.setItem(storageKey, JSON.stringify(entry));
      }
      await current();
    }
    try {
      const obsTarget = await entryCommand<{ executablePath?: string }>(
        '/operator/obs/launch-target',
        {},
        entrySignal,
      );
      if (!obsTarget.executablePath) throw new Error('未找到 OBS 可执行文件，请检查安装后重试。');
      await ensureEntryObs(entrySignal);
      await current();
      await entryCommand(
        '/operator/obs/video-preflight',
        { expectedRevision: state.revision },
        entrySignal,
      );
      await current();
      const video = await entryCommand<{ transactionId: string | null }>(
        '/operator/obs/video-prepare',
        { expectedRevision: state.revision },
        entrySignal,
      );
      onVideoPrepared?.(video.transactionId);
      await current();
      await prepareObs(state.revision, entrySignal, entry.id);
      const prepared = await readObsForEntry(entrySignal);
      if (prepared?.connection !== 'connected') throw new Error('OBS 连接已中断，请重试。');
      if (!prepared.readiness?.ready)
        throw new Error(prepared.readiness?.reason ?? 'OBS 准备状态未确认，请重试。');
      if (lastPreparation?.id === entry.id) lastPreparation.obs = true;
      await current();
    } catch (error) {
      if (cancelled() || entrySignal.aborted) throw error;
      onWarning?.(error instanceof Error ? error.message : 'OBS 准备未完成。');
      await current();
    }
    try {
      const gsi = await desktopInvoke<GsiStatus>('gsi_status', undefined, task);
      const issue = gsiProblem(gsi);
      if (issue) throw new Error(issue);
      const configured = await desktopInvoke<GsiStatus>(
        'ensure_gsi',
        { preparationId: entry.id },
        task,
      );
      if (gsiProblem(configured) || !configured.installed || configured.conflict)
        throw new Error(
          gsiProblem(configured) ??
            configured.issues?.[0]?.message ??
            'GSI 自动配置未完成，请重试。',
        );
      window.dispatchEvent(new Event('mizar:gsi-configured'));
      if (lastPreparation?.id === entry.id) lastPreparation.gsi = true;
    } catch (error) {
      if (cancelled() || entrySignal.aborted) throw error;
      onWarning?.(error instanceof Error ? error.message : 'GSI 准备未完成。');
    }
    await current();
  }
  if (
    action === 'enter' &&
    !window.__TAURI_INTERNALS__ &&
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
  let borrowed = false;
  let launchedMulnx = false;
  let mulnxFailed = false;
  if (action === 'enter' && window.__TAURI_INTERNALS__) {
    try {
      if (launch?.mulnxLaunchResumable) {
        const result = await desktopInvoke<{ result?: string }>(
          'launch_mulnx',
          { resumeOnly: true, preparationId: entry?.id },
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
          {
            automatic: true,
            preparationId: entry?.id,
            ...(preserveSettings ? { preserveSettings: true } : {}),
          },
          task,
        );
        launchedMulnx = true;
        if (cancelled() || window.location.href !== entryLocation) {
          task.finish('cancelled', { reason: 'navigation_changed' });
          return;
        }
      }
    } catch (error) {
      if (cancelled() || entrySignal.aborted) throw error;
      mulnxFailed = true;
      onWarning?.(
        `MulNX 启动未确认：${error instanceof Error ? error.message : '操作未完成。'} 请核对游戏状态后重试。`,
      );
    }
    if (launchedMulnx && !(await entryStillCurrent())) {
      task.finish('cancelled', { reason: 'production_changed' });
      return;
    }
    if (!mulnxFailed && ((!launch?.running && !launch?.pending) || launchedMulnx))
      newlyStarted = await desktopInvoke<boolean>(
        'start_managed_cs2',
        {
          preparationId: entry?.id,
          ...(preserveSettings && !launchedMulnx ? { preserveSettings: true } : {}),
        },
        task,
      );
    let gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
    borrowed = gameStatus.borrowed ?? borrowed;
    // Preserve this one entry intent while the native command lock is free.
    // Recovery/cancel remains available; navigation cancels only entry intent.
    const waitStarted = Date.now();
    while (!mulnxFailed && !gameStatus.running) {
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
    state.mode === 'preparation' &&
    !mulnxFailed
  ) {
    try {
      if (!entry?.since) throw new Error('本次游戏启动时间未确认，请结束本次游戏后重试。');
      const warmup = await entryCommand<{ transactionId: string; startedAt: number }>(
        '/operator/obs/capture-warmup',
        { expectedRevision: state.revision, preparationId: entry.id },
        entrySignal,
      );
      const deadline = warmup.startedAt + 60_000;
      let reason = 'evidence_unknown';
      let initialized = false;
      let failure: unknown;
      try {
        while (Date.now() < deadline && !entrySignal.aborted) {
          const capture = await entryCommand<{ state: string; reason: string | null }>(
            '/operator/obs/capture-initialization',
            {
              expectedRevision: state.revision,
              since: warmup.startedAt,
              transactionId: warmup.transactionId,
            },
            entrySignal,
          );
          if (capture.state === 'initialized') {
            initialized = true;
            break;
          }
          reason = capture.reason ?? 'evidence_unknown';
          if (capture.state === 'failed' || reason === 'source_inactive') break;
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        }
        if (!initialized) {
          if (entrySignal.aborted) throw new Error('启动已取消。');
          const messages: Record<string, string> = {
            source_unavailable: 'OBS 游戏采集来源不可用。',
            target_unavailable: '未找到 CS2 窗口。',
            target_ambiguous: '发现多个 CS2 窗口，无法确认采集目标。',
            source_inactive: 'OBS 游戏采集准备已失效，无法确认画面。',
            zero_size: 'OBS 游戏采集画面仍为 0×0。',
            hook_pending: 'OBS 游戏采集仍在重试。',
            hook_failed: 'OBS 游戏采集初始化失败。',
            evidence_unknown: 'OBS 游戏采集状态未确认。',
          };
          throw new Error(`${messages[reason] ?? messages.evidence_unknown} 请检查原因后重试。`);
        }
      } catch (error) {
        failure = error;
      }
      try {
        await entryCommand('/operator/obs/capture-warmup-release', {
          transactionId: warmup.transactionId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '临时捕获来源清理未确认。';
        throw new Error(`${failure instanceof Error ? `${failure.message} ` : ''}${message}`, {
          cause: error,
        });
      }
      if (failure) throw failure;
      if (lastPreparation?.id === entry.id) lastPreparation.capture = true;
    } catch (error) {
      if (cancelled() || entrySignal.aborted) throw error;
      onWarning?.(error instanceof Error ? error.message : '游戏捕获未确认。');
    }
  }
  if (action === 'enter' && (cancelled() || window.location.href !== entryLocation)) {
    task.finish('cancelled', { reason: 'navigation_changed' });
    return;
  }
  if (
    action === 'enter' &&
    window.__TAURI_INTERNALS__ &&
    state.mode === 'preparation' &&
    !mulnxFailed
  ) {
    await desktopInvoke(
      'begin_managed_camera',
      { expectedRevision: state.revision, preparationId: entry?.id },
      task,
    )
      .then(() => {
        if (lastPreparation && entry && lastPreparation.id === entry.id) {
          lastPreparation.camera = true;
          lastPreparation.cameraUncertain = false;
        }
      })
      .catch((error: unknown) => {
        if (lastPreparation && entry && lastPreparation.id === entry.id)
          lastPreparation.cameraUncertain = true;
        onWarning?.(error instanceof Error ? error.message : '运镜未准备完成。');
      });
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
      if (window.__TAURI_INTERNALS__ && state.mode === 'preparation')
        await desktopInvoke('cancel_managed_camera', undefined, task);
      task.finish('cancelled', { reason: 'navigation_changed' });
      return;
    }
    if (window.__TAURI_INTERNALS__) {
      await desktopInvoke(
        'present_production',
        { live: action === 'enter', ...(entry ? { preparationId: entry.id } : {}) },
        task,
      );
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
