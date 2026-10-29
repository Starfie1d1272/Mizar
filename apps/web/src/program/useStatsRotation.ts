import { useEffect, useState } from 'react';
import { broadcastStatsSchema } from '@mizar/protocol/broadcast-stats';
import type { StatsInsert } from '@mizar/hud-view';
import { statsInserts } from './stats-inserts';

const sequence = [
  ['LINEUPS', 12_000],
  ['MAP PERFORMANCE', 15_000],
  ['RECENT MAPS', 15_000],
  ['PLAYER COMPARISON', 12_000],
  ['PLAYER ATTRIBUTES', 15_000],
  ['PISTOL & CONVERSION', 12_000],
  ['ECONOMY', 12_000],
  ['UTILITY', 12_000],
] as const;

/** The current card is immutable; the next boundary reads the latest local snapshot. */
export function useStatsRotation(enabled: boolean, matchId: string | null): StatsInsert | null {
  const [visible, setVisible] = useState<{ matchId: string; card: StatsInsert } | null>(null);
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
        const response = await fetch('/local/v1/broadcast-stats', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        const parsed = broadcastStatsSchema.safeParse(response.ok ? await response.json() : null);
        if (!active) return;
        if (!parsed.success || parsed.data.matchId !== matchId) {
          main();
          return;
        }
        const cards = statsInserts(parsed.data);
        while (index < sequence.length) {
          const [name, duration] = sequence[index++]!;
          const card = cards.find((item) => item.subtitle === name);
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
