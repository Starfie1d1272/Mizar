import { ControlTask } from '../debug/control-task';
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
  if (signal?.aborted || !isCurrent()) return false;
  await enterDesktopWorkspace({ expectedDemoRequest: requestId }, task, signal);
  return !signal?.aborted && isCurrent();
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
  sessionId?: string;
  canEnter: boolean;
  releaseHandoffState?: 'idle' | 'pending' | 'recorded' | 'confirmed' | 'unconfirmed';
  obsExitState?: 'idle' | 'pending' | 'confirmed' | 'unconfirmed';
}

/** Retry only the Companion OBS exit task; do not repeat Host game cleanup. */
export async function retryObsExit(state: Production): Promise<void> {
  const latest = await fetch('/local/v1/production', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!latest.ok) throw new Error('OBS 收尾状态未确认，请检查后重试。');
  const currentState = (await latest.json()) as Production;
  if (state.mode !== 'preparation' || currentState.mode !== 'preparation')
    throw new Error('制作状态已变化，请检查 OBS。');
  if (!state.sessionId || currentState.sessionId !== state.sessionId)
    throw new Error('制作状态已变化，请检查 OBS。');
  if (currentState.obsExitState !== 'unconfirmed')
    throw new Error('OBS 收尾状态已变化，请刷新后核对。');
  const response = await fetch('/operator/production', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'finish', expectedRevision: currentState.revision }),
    signal: AbortSignal.timeout(10000),
  });
  let current = (await response.json().catch(() => ({}))) as Partial<Production> & {
    message?: string;
  };
  if (!response.ok) throw new Error(current.message ?? 'OBS 收尾重试未完成。');
  if (current.mode !== 'preparation') throw new Error('制作状态已变化，请检查 OBS。');
  const retryRevision = current.revision;
  if (!retryRevision) throw new Error('OBS 收尾状态未确认，请检查后重试。');
  const deadline = Date.now() + 30000;
  while (current.obsExitState === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await fetch('/local/v1/production', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!status.ok) throw new Error('OBS 收尾状态未确认，请检查后重试。');
    current = (await status.json()) as Production;
    if (current.mode !== 'preparation' || current.revision !== retryRevision)
      throw new Error('制作状态已变化，请检查 OBS。');
  }
  if (current.obsExitState !== 'confirmed')
    throw new Error('OBS 等待画面尚未确认，请检查连接和当前场景后重试。');
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

let pendingEntry: AbortController | undefined;
let activeEntryId: string | undefined;
export async function cancelProductionEntry() {
  if (!window.__TAURI_INTERNALS__) return;
  pendingEntry?.abort();
  await desktopInvoke('cancel_workspace_entry', { entryId: activeEntryId ?? null });
}
export async function retryPendingPreparation() {
  await desktopInvoke('retry_workspace_entry');
}

async function enterDesktopWorkspace(
  options: {
    expectedRevision?: string;
    expectedDemoRequest?: string;
    manual?: boolean;
    preserveSettings?: boolean;
    external?: ExternalGameIdentity | undefined;
  },
  task?: ControlTask,
  signal?: AbortSignal,
) {
  if (activeEntryId) throw new Error('正在进入工作台，请稍候。');
  if (signal?.aborted) throw new Error('进入已取消。');
  const preparationId = crypto.randomUUID();
  activeEntryId = preparationId;
  const cancel = () =>
    void desktopInvoke('cancel_entry_intent', { intentId: preparationId }).catch(() => {});
  window.addEventListener('pagehide', cancel);
  window.addEventListener('popstate', cancel);
  signal?.addEventListener('abort', cancel);
  try {
    await desktopInvoke(
      'enter_workspace',
      {
        preparationId,
        expectedRevision: options.expectedRevision ?? null,
        expectedDemoRequest: options.expectedDemoRequest ?? null,
        manual: options.manual ?? false,
        preserveSettings: options.preserveSettings ?? false,
        externalPid: options.external?.pid ?? null,
        externalCreated: options.external?.created ?? null,
      },
      task,
    );
  } finally {
    window.removeEventListener('pagehide', cancel);
    window.removeEventListener('popstate', cancel);
    signal?.removeEventListener('abort', cancel);
    if (activeEntryId === preparationId) activeEntryId = undefined;
  }
}

export async function enterProductionManually(state: Production) {
  await enterDesktopWorkspace({ expectedRevision: state.revision, manual: true });
}

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
    { ...state, preserveSettings, external },
    parentTask,
  );
  const entryAbort =
    action === 'enter' && state.mode === 'preparation' ? new AbortController() : undefined;
  if (entryAbort) pendingEntry = entryAbort;
  try {
    if (window.__TAURI_INTERNALS__ && action === 'finish') {
      await desktopInvoke('finish_workspace', undefined, task);
      const [production, source] = await Promise.all([
        fetch('/local/v1/production', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
          .then((response) => (response.ok ? (response.json() as Promise<Production>) : null))
          .catch(() => null),
        fetch('/local/v1/rivalhub-connection', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        })
          .then((response) =>
            response.ok
              ? (response.json() as Promise<{
                  sourceCleanup?: {
                    pending: number;
                    blocked: number;
                    claimIntent: boolean;
                    handoffPending?: number;
                  };
                }>)
              : null,
          )
          .catch(() => null),
      ]);
      const cleanup = source?.sourceCleanup;
      if (
        !production ||
        !source ||
        production.obsExitState === 'pending' ||
        production.obsExitState === 'unconfirmed' ||
        production.releaseHandoffState === 'pending' ||
        production.releaseHandoffState === 'unconfirmed' ||
        !cleanup ||
        cleanup.pending > 0 ||
        cleanup.blocked > 0 ||
        cleanup.claimIntent ||
        (cleanup.handoffPending ?? 0) > 0
      ) {
        task.finish('unconfirmed', { reason: 'local_cleanup_complete_remote_or_obs_pending' });
        return task.result;
      }
    } else if (window.__TAURI_INTERNALS__ && action === 'enter') {
      void fetch('/operator/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...task.headers() },
        body: JSON.stringify({ action: 'entry-check' }),
        keepalive: true,
        signal: AbortSignal.timeout(40_000),
      }).catch(() => {});
      await enterDesktopWorkspace(
        { expectedRevision: state.revision, preserveSettings, external },
        task,
        entryAbort?.signal,
      );
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
    if (entryAbort?.signal.aborted) {
      task.finish('cancelled', { reason: 'entry_cancelled' });
      return task.result;
    }
    task.fail(error);
    throw error;
  } finally {
    if (pendingEntry === entryAbort) pendingEntry = undefined;
  }
}
