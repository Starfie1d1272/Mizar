import { useEffect, useState } from 'react';
import { desktopInvoke } from '../workspace/client';

export interface Cs2ConfigStatus {
  qualityPreset: 'very-high' | 'high' | 'medium' | 'preserve';
  frameRateLimit: 0 | 30 | 60;
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
      ? '正在关闭游戏并恢复配置…'
      : '正在检查 CS2 配置…';
}
