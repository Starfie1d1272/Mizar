import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalTournamentView } from '../workspace/LocalTournamentEditor';
export function useLocalTournament() {
  const [read, setRead] = useState<{
    view: LocalTournamentView | null;
    status: 'loading' | 'ready' | 'stale' | 'error';
  }>({ view: null, status: 'loading' });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const response = await fetch('/local/v1/tournament', {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error('tournament_unavailable');
      const view = (await response.json()) as LocalTournamentView;
      if (request === generation.current) setRead({ view, status: 'ready' });
    } catch {
      if (request === generation.current)
        setRead((current) => ({ ...current, status: current.view ? 'stale' : 'error' }));
    }
  }, []);
  useEffect(() => {
    const requests = generation;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      active = false;
      requests.current++;
      clearTimeout(timer);
    };
  }, [refresh]);
  return { ...read, refresh };
}
