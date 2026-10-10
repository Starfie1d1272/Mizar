import type { Cs2ConfigStatus } from './cs2-status';
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
export async function command(path: string, body: unknown = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new Error(result.message ?? '操作未完成，请刷新后重试。');
  return result;
}
export type Tool = 'hud' | 'bp' | 'diagnostics' | 'preview';
const toolPaths = {
  hud: '/operator/hud',
  bp: '/preview?scene=bp',
  diagnostics: '/debug',
  preview: '/preview',
};
export async function openTool(tool: Tool) {
  if (window.__TAURI_INTERNALS__) await desktopInvoke('open_tool', { tool });
  else window.open(toolPaths[tool], `mizar-${tool === 'bp' ? 'preview' : tool}`);
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
export async function checkObsBeforeLaunch() {
  // Installation is checkable before launch; fresh telemetry is not.
  if (window.__TAURI_INTERNALS__) {
    const gsi = await desktopInvoke<{ installed: boolean; conflict: boolean }>('gsi_status');
    if (!gsi.installed || gsi.conflict) {
      window.location.assign('/settings?tab=gsi&prepare=1');
      return false;
    }
  }
  // A fresh UI readiness check; Companion still owns the production lifecycle.
  const obs = await fetch('/local/v1/obs', {
    cache: 'no-store',
    signal: AbortSignal.timeout(6000),
  })
    .then(async (response) =>
      response.ok
        ? ((await response.json()) as {
            connection: string;
            findings: readonly unknown[];
          })
        : null,
    )
    .catch(() => null);
  if (obs?.connection !== 'connected' || obs.findings.length > 0) {
    window.location.assign('/settings?tab=obs&prepare=1');
    return false;
  }
  return true;
}

export async function productionAction(action: 'enter' | 'hide' | 'finish', state: Production) {
  const entryLocation = window.location.href;
  if (action === 'enter' && !(await checkObsBeforeLaunch())) return;
  let newlyStarted = false;
  if (action === 'enter' && window.__TAURI_INTERNALS__) {
    newlyStarted = await desktopInvoke<boolean>('start_managed_cs2');
    let gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status');
    // Preserve this one entry intent while the native command lock is free.
    // Recovery/cancel remains available; navigation cancels only entry intent.
    while (!gameStatus.running) {
      if ((!gameStatus.busy && !gameStatus.pending) || window.location.href !== entryLocation)
        return;
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (window.location.href !== entryLocation) return;
      gameStatus = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status');
    }
  }
  if (action === 'enter' && window.location.href !== entryLocation) return;
  try {
    await command('/operator/production', { action, expectedRevision: state.revision });
    if (window.__TAURI_INTERNALS__) {
      if (action === 'finish') {
        // Companion has finished. A window failure must not skip game cleanup.
        let presentationError: unknown;
        try {
          await desktopInvoke('present_production', { live: false });
        } catch (reason) {
          presentationError = reason;
        }
        await desktopInvoke('finish_managed_cs2');
        if (presentationError)
          throw presentationError instanceof Error
            ? presentationError
            : new Error('准备中心未能打开。', { cause: presentationError });
      } else await desktopInvoke('present_production', { live: action === 'enter' });
    } else window.location.assign(action === 'enter' ? '/workspace' : '/');
  } catch (reason) {
    if (action !== 'enter' || !window.__TAURI_INTERNALS__) throw reason;
    const actual = await fetch('/local/v1/production', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
      .then(async (response) => (response.ok ? ((await response.json()) as Production) : null))
      .catch(() => null);
    const detail = reason instanceof Error ? reason.message : '操作未完成。';
    const game = newlyStarted ? 'CS2 已启动' : '受管理的 CS2 已保留';
    throw new Error(
      `${game}，${actual?.mode === 'live' ? '制作已开始，但工作台尚未打开' : actual?.mode === 'preparation' ? '工作台尚未进入' : '制作状态待确认'}。重试打开工作台，或退出本次游戏并恢复设置。${detail}`,
      { cause: reason },
    );
  }
}
