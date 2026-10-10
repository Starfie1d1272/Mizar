import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';

export function useLocalReadWithTime<T>(
  path: string | null,
  interval = 2000,
  refresh = 0,
  retainReadOnly = false,
) {
  const [value, setValue] = useState<{
    value: T | null;
    updatedAt: number | null;
    status: 'loading' | 'ready' | 'stale' | 'unavailable';
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
        if (active)
          setValue((previous) =>
            retainReadOnly && previous.value !== null
              ? { ...previous, status: 'stale' }
              : { value: null, updatedAt: null, status: 'unavailable' },
          );
      } finally {
        if (active) timer = setTimeout(() => void poll(), interval);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, interval, refresh, retainReadOnly]);
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
  bp: '/operator/bp',
  diagnostics: '/debug',
  preview: '/preview',
};
export async function openTool(tool: Tool, presetId?: string) {
  if (window.__TAURI_INTERNALS__)
    await desktopInvoke('open_tool', { tool, ...(tool === 'hud' && presetId ? { presetId } : {}) });
  else if (tool !== 'hud') window.open(toolPaths[tool], `mizar-${tool}`);
  else {
    const path = toolPaths.hud + (presetId ? `?preset=${encodeURIComponent(presetId)}` : '');
    // A same-origin named editor preserves its in-flight drafts through its own selection gate.
    const existing = window.open('', 'mizar-hud');
    if (!existing) throw new Error('工具窗口未能打开，请允许本机弹出窗口。');
    if (existing.location.pathname === toolPaths.hud) {
      if (presetId)
        existing.dispatchEvent(new CustomEvent('mizar:hud-select-preset', { detail: presetId }));
      existing.focus();
    } else existing.location.assign(new URL(path, window.location.origin).href);
  }
}
export async function openRivalHubAuthorization(url: string, popup?: Window | null) {
  if (window.__TAURI_INTERNALS__) await desktopInvoke('open_rivalhub_authorization', { url });
  else if (popup && !popup.closed) popup.location.replace(url);
  else window.open(url, 'mizar-rivalhub');
}
export function productionEntryLabel(production: Production | null, desktop: boolean): string {
  return production?.mode === 'live' || production?.mode === 'hidden'
    ? '返回现有现场'
    : desktop
      ? '启动新制作并进入现场'
      : '进入制播工作区';
}

export interface Production {
  cleanup?: {
    at: string;
    scene: 'pending' | 'confirmed' | 'failed';
    source: 'pending' | 'confirmed' | 'failed';
  } | null;
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

export async function productionAction(
  action: 'enter' | 'hide' | 'finish',
  state: Production,
  onProgress: (message: string) => void = () => {},
) {
  const newProduction = action === 'enter' && state.mode === 'preparation';
  if (newProduction) onProgress('正在检查 GSI 配置与 OBS 场景…');
  if (newProduction && !(await checkObsBeforeLaunch())) return;
  let newlyStarted = false;
  if (newProduction && window.__TAURI_INTERNALS__) {
    onProgress('Host 正在备份配置并启动受管理 CS2…');
    newlyStarted = await desktopInvoke<boolean>('start_managed_cs2');
  }
  try {
    onProgress(action === 'finish' ? '正在收起节目并释放网站数据源…' : '正在确认制作状态…');
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
        onProgress('节目已收起、数据源已释放；Host 正在关闭受管理游戏并恢复配置…');
        await desktopInvoke('finish_managed_cs2');
        onProgress('节目与数据源收尾已确认；Host 游戏与配置清理已确认。OBS 输出需单独核对。');
        if (presentationError)
          throw presentationError instanceof Error
            ? presentationError
            : new Error('准备中心未能打开。', { cause: presentationError });
      } else {
        onProgress('正在显示已有制播工作区…');
        await desktopInvoke('present_production', { live: action === 'enter' });
      }
    } else
      window.location.assign(
        action === 'enter' ? '/workspace' : action === 'finish' ? '/?tab=finish' : '/',
      );
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
