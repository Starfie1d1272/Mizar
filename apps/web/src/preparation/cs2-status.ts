import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';

export interface Cs2ConfigStatus {
  qualityPreset: 'very-high' | 'high' | 'medium' | 'preserve';
  frameRateLimit: 0 | 30 | 60;
  spectatorRecoveryPending?: boolean;
  demoCleanupPending?: boolean;
  spectatorWarning?: string | null;
  canPreserve?: boolean;
  preserveSettings?: boolean;
  pending: boolean;
  running: boolean;
  message: string | null;
  busy?: boolean;
  phase?: 'idle' | 'starting' | 'checking' | 'restoring' | 'uncertain' | 'running' | 'pending';
}
export function useCs2Status() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const [status, setStatus] = useState<Cs2ConfigStatus | null>(null);
  const [phase, setPhase] = useState<Cs2ConfigStatus['phase']>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status');
        if (active) {
          // A busy response deliberately has no game/config facts: retain the
          // last snapshot, and display only its separate operation label.
          if (!next.busy) setStatus(next);
          setPhase(
            next.busy && ['starting', 'restoring', 'checking'].includes(next.phase ?? '')
              ? next.phase
              : undefined,
          );
          setError('');
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : '无法读取 CS2 设置。');
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [desktop, revision]);
  return { status, phase, error, refresh: () => setRevision((current) => current + 1) };
}
export function cs2OperationLabel(phase: Cs2ConfigStatus['phase']) {
  return phase === 'starting'
    ? '正在启动 CS2，等待 Steam…'
    : phase === 'restoring'
      ? '正在关闭本次游戏…'
      : '正在检查 CS2 配置…';
}

export interface WorkspaceExitStatus {
  busy: boolean;
  stage: 'checking' | 'production' | 'restoration' | 'presentation' | '';
  message: string | null;
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
        const next = await desktopInvoke<WorkspaceExitStatus>('workspace_exit_status');
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
      : stage === 'restoration'
        ? '关闭游戏与恢复设置'
        : '返回准备中心';
}
