import { useCallback, useEffect, useState } from 'react';
import type { LocalTournamentView } from '../workspace/LocalTournamentEditor';
export function useLocalTournament() {
  const [read, setRead] = useState<{
    view: LocalTournamentView | null;
    status: 'loading' | 'ready' | 'stale' | 'error';
  }>({ view: null, status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/local/v1/tournament', {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error('tournament_unavailable');
      setRead({ view: (await response.json()) as LocalTournamentView, status: 'ready' });
    } catch {
      setRead((current) => ({ ...current, status: current.view ? 'stale' : 'error' }));
    }
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  return { ...read, refresh };
}
