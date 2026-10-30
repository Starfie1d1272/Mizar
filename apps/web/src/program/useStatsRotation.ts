import { useEffect, useState } from 'react';
import { broadcastStatsPresentationSchema } from '@mizar/protocol/broadcast-stats-presentation';
import { statsInserts, type StatsCard } from './stats-inserts';

const sequence = [
  ['lineups', 12_000],
  ['maps', 15_000],
  ['recent', 15_000],
  ['player-comparison', 12_000],
  ['player-attributes', 15_000],
  ['pistol', 12_000],
  ['economy', 12_000],
  ['utility', 12_000],
] as const;

/** The current card is immutable; the next boundary reads the latest local snapshot. */
export function useStatsRotation(enabled: boolean, matchId: string | null): StatsCard | null {
  const [visible, setVisible] = useState<{ matchId: string; card: StatsCard } | null>(null);
  useEffect(() => {
    if (!enabled || !matchId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let index = 0;
    let page = 0;
    const main = () => {
      setVisible(null);
      index = 0;
      page = 0;
      timer = setTimeout(() => void next(), 20_000);
    };
    const next = async () => {
      try {
        const response = await fetch('/local/v1/broadcast-stats-presentation', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        const parsed = broadcastStatsPresentationSchema.safeParse(
          response.ok ? await response.json() : null,
        );
        if (!active) return;
        if (!parsed.success || parsed.data.matchId !== matchId) {
          main();
          return;
        }
        const cards = statsInserts(parsed.data);
        while (index < sequence.length) {
          const [name, duration] = sequence[index]!;
          const matching = cards.filter((item) => item.id === name);
          const card = matching[page++];
          if (page >= matching.length) {
            index++;
            page = 0;
          }
          if (card) {
            setVisible({ matchId, card });
            timer = setTimeout(() => void next(), duration);
            return;
          }
        }
        main();
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
