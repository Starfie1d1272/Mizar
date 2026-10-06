import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';

export function useLocalRead<T>(path: string | null, interval = 2000, refresh = 0) {
  const [value, setValue] = useState<T | null>(null);
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
        if (active) setValue(next);
      } catch {
        if (active) setValue(null);
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
export async function productionAction(action: 'enter' | 'hide' | 'finish', state: Production) {
  if (action === 'enter') {
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
      return;
    }
  }
  await command('/operator/production', { action, expectedRevision: state.revision });
  if (window.__TAURI_INTERNALS__)
    await desktopInvoke('present_production', { live: action === 'enter' });
  else window.location.assign(action === 'enter' ? '/workspace' : '/');
}
