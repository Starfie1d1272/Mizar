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
export function prepareObs(expectedRevision?: string, signal?: AbortSignal) {
  if (pending) return pending;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  window.addEventListener('pagehide', cancel);
  window.addEventListener('popstate', cancel);
  const current = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
  publish({ phase: 'running', message: '正在准备 Mizar 场景与音频…' });
  pending = (async () => {
    const revision =
      expectedRevision ??
      (await fetch('/local/v1/production', {
        cache: 'no-store',
        signal: AbortSignal.any([current, AbortSignal.timeout(5000)]),
      }).then(async (response) => {
        if (!response.ok) throw new Error('制作状态未确认，请重试。');
        return ((await response.json()) as { revision: string }).revision;
      }));
    return obsCommand('ensure', { expectedRevision: revision }, current);
  })()
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
      window.removeEventListener('pagehide', cancel);
      window.removeEventListener('popstate', cancel);
      pending = null;
    });
  return pending;
}
