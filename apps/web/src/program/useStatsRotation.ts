import { useEffect, useState } from 'react';
import { broadcastStatsProgramSchema } from '@mizar/protocol/broadcast-stats-presentation';
import type { StatsInsert } from '@mizar/hud-view';
import { statsProgramInserts } from './stats-program';

type StatsCard = StatsInsert & { readonly id: string };

/** The current card is immutable; the next boundary reads the latest local snapshot. */
export function useStatsRotation(enabled: boolean, matchId: string | null): StatsCard | null {
  const [visible, setVisible] = useState<{ matchId: string; card: StatsCard } | null>(null);
  useEffect(() => {
    if (!enabled || !matchId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let index = 0;
    const main = () => {
      setVisible(null);
      index = 0;
      timer = setTimeout(() => void next(), 20_000);
    };
    const next = async () => {
      try {
        const response = await fetch('/local/v1/broadcast-stats-program', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        const parsed = broadcastStatsProgramSchema.safeParse(
          response.ok ? await response.json() : null,
        );
        if (!active) return;
        if (!parsed.success || parsed.data.matchId !== matchId) {
          main();
          return;
        }
        const page = parsed.data.pages[index];
        const card = statsProgramInserts(parsed.data)[index];
        if (!page || !card) {
          main();
          return;
        }
        index++;
        setVisible({ matchId, card });
        const duration = ['maps', 'maps-info', 'recent', 'radar'].includes(page.kind)
          ? 15_000
          : 12_000;
        timer = setTimeout(() => void next(), duration);
      } catch {
        if (active) main();
      }
    };
    timer = setTimeout(() => void next(), 20_000);
    return () => {
      active = false;
      clearTimeout(timer);
      setVisible(null);
    };
  }, [enabled, matchId]);
  return enabled && visible?.matchId === matchId ? visible.card : null;
}
