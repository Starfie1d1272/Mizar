import { useCallback, useEffect, useState } from 'react';
import type { LocalTournamentView } from '../workspace/LocalTournamentEditor';
export function useLocalTournament() {
  const [view, setView] = useState<LocalTournamentView | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/local/v1/tournament', {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) setView((await response.json()) as LocalTournamentView);
    } catch {
      setView(null);
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
  return { view, refresh };
}
