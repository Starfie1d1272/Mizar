import { useEffect, useState, useSyncExternalStore } from 'react';
import { desktopInvoke } from '../workspace/client';

import type { Cs2ConfigStatus, Cs2Status, WorkspaceExitStatus } from '@mizar/protocol/desktop-ipc';
export type { Cs2ConfigStatus } from '@mizar/protocol/desktop-ipc';

let current: { status: Cs2ConfigStatus | null; phase?: Cs2Status['phase']; error: string } = {
  status: null,
  error: '',
};
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;

async function pollCs2Status() {
  if (!listeners.size || polling) return;
  clearTimeout(pollTimer);
  polling = true;
  try {
    const next = await desktopInvoke('cs2_config_status');
    current = next.busy
      ? {
          status: current.status,
          ...(next.phase === 'idle' ? {} : { phase: next.phase }),
          error: '',
        }
      : { status: next, error: '' };
  } catch (error) {
    current = {
      ...current,
      error: error instanceof Error ? error.message : '无法读取 CS2 设置。',
    };
  } finally {
    polling = false;
    if (listeners.size) pollTimer = setTimeout(() => void pollCs2Status(), 1000);
  }
  for (const listener of listeners) listener();
}

function subscribeCs2Status(listener: () => void) {
  if (!window.__TAURI_INTERNALS__) return () => {};
  listeners.add(listener);
  if (listeners.size === 1) void pollCs2Status();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearTimeout(pollTimer);
  };
}

const getCs2Status = () => current;
const refreshCs2Status = () => void pollCs2Status();

export function useCs2Status() {
  const snapshot = useSyncExternalStore(subscribeCs2Status, getCs2Status, getCs2Status);
  return { ...snapshot, refresh: refreshCs2Status };
}
export function cs2OperationLabel(phase: Cs2Status['phase']) {
  return phase === 'starting'
    ? '正在启动 CS2，等待 Steam…'
    : phase === 'restoring'
      ? '正在关闭本次游戏…'
      : '正在检查 CS2 配置…';
}

/** Read-only Host feedback: survives navigation and hidden workspace windows. */
export function useWorkspaceExitStatus() {
  const [status, setStatus] = useState<WorkspaceExitStatus | null>(null);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await desktopInvoke('workspace_exit_status');
        if (active) setStatus(next);
      } catch {
        // Keep the last confirmed outcome; CS2 status reports Host read failures.
      } finally {
        if (active) timer = setTimeout(() => void poll(), 500);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}
export function workspaceExitLabel(stage: WorkspaceExitStatus['stage']) {
  return stage === 'checking'
    ? '确认制作与试播状态'
    : stage === 'production'
      ? '安全切场与数据源释放'
      : stage === 'detachment'
        ? '解除外部游戏借用'
        : stage === 'restoration'
          ? '关闭游戏与恢复设置'
          : '返回准备中心';
}
