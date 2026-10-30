import { useEffect, useState } from 'react';
import {
  broadcastStatsProgramSchema,
  type BroadcastStatsProgram,
} from '@mizar/protocol/broadcast-stats-presentation';
import { statsProgramInserts } from './stats-program';

type Card = ReturnType<typeof statsProgramInserts>[number];
type PageKind = BroadcastStatsProgram['pages'][number]['kind'];
const shortPages: ReadonlySet<PageKind> = new Set(['lineup', 'players', 'economy', 'utility']);

/** Freeze each displayed card; read Companion's qualified order at the next boundary. */
export function useStatsRotation(enabled: boolean, matchId: string | null): Card | null {
  const [visible, setVisible] = useState<{ matchId: string; card: Card } | null>(null);
  useEffect(() => {
    if (!enabled || !matchId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const shown = new Set<string>();
    const main = () => {
      setVisible(null);
      shown.clear();
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
        const index = parsed.data.pages.findIndex((page) => !shown.has(page.id));
        const page = parsed.data.pages[index];
        const card = statsProgramInserts(parsed.data)[index];
        if (!page || !card) {
          main();
          return;
        }
        shown.add(page.id);
        setVisible({ matchId, card });
        timer = setTimeout(() => void next(), shortPages.has(page.kind) ? 12_000 : 15_000);
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
