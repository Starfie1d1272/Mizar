import { useSyncExternalStore } from 'react';
import { obsCommand } from './obs-client';

type Preparation = { phase: 'idle' | 'running' | 'completed' | 'failed'; message: string };
let state: Preparation = { phase: 'idle', message: '' };
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
function publish(next: Preparation) {
  state = next;
  for (const listener of listeners) listener();
}
export function useObsPreparation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
}
/** Request progress only; OBS findings remain the authority for readiness. */
export function prepareObs() {
  if (pending) return pending;
  publish({ phase: 'running', message: '正在准备 Mizar 场景与音频…' });
  pending = obsCommand('ensure')
    .then(() => {
      publish({ phase: 'completed', message: '' });
    })
    .catch((error: unknown) => {
      publish({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'OBS 自动配置未完成，请重试。',
      });
      throw error;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
