import { useEffect, useRef } from 'react';
import { controlEvidence } from '../debug/control-journal';

/** Counts eligibility in this document's mounted, visible hint list. */
export function useObserverHintEvidence(scope: string, visibleIds: string, endReason: string) {
  const evidence = useRef({
    scope: '',
    seen: new Set<string>(),
    active: new Map<string, number>(),
    firstVisible: 0,
    samples: [] as string[],
    ended: {} as Record<string, { intervals: number; totalMs: number }>,
  });

  useEffect(() => {
    const state = evidence.current;
    if (state.scope !== scope) {
      update(state, [], 'program_scope_changed');
      flush(state);
      state.scope = scope;
      state.seen.clear();
    }
    const refresh = () =>
      update(
        state,
        document.visibilityState === 'visible' && visibleIds ? visibleIds.split(',') : [],
        document.visibilityState === 'visible' ? endReason : 'document_hidden',
      );
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [scope, visibleIds, endReason]);

  useEffect(() => {
    const state = evidence.current;
    const timer = window.setInterval(() => flush(state), 30_000);
    const close = () => {
      update(state, [], 'document_ended');
      flush(state);
    };
    window.addEventListener('pagehide', close);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', close);
      close();
    };
  }, []);
}

type Evidence = {
  scope: string;
  seen: Set<string>;
  active: Map<string, number>;
  firstVisible: number;
  samples: string[];
  ended: Record<string, { intervals: number; totalMs: number }>;
};

function update(state: Evidence, ids: readonly string[], reason: string) {
  const now = performance.now();
  for (const [id, start] of state.active) {
    if (ids.includes(id)) continue;
    const group = (state.ended[reason] ??= { intervals: 0, totalMs: 0 });
    group.intervals++;
    group.totalMs += Math.round(now - start);
    state.active.delete(id);
  }
  for (const id of ids) {
    if (state.active.has(id)) continue;
    state.active.set(id, now);
    if (state.seen.has(id) || state.seen.size >= 4096) continue;
    state.seen.add(id);
    state.firstVisible++;
    if (state.samples.length < 8) state.samples.push(id);
  }
}

function flush(state: Evidence) {
  if (state.firstVisible === 0 && Object.keys(state.ended).length === 0) return;
  controlEvidence('observer_hint_presentation', 'summary', {
    programScope: state.scope,
    firstVisible: state.firstVisible,
    pending: state.active.size,
    ended: state.ended,
    samples: state.samples,
    dedupLimitReached: state.seen.size >= 4096,
  });
  state.firstVisible = 0;
  state.samples = [];
  state.ended = {};
}
