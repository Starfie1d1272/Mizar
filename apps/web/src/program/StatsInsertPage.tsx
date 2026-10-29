import { useEffect, useState, useSyncExternalStore } from 'react';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import { StatsInsertView } from '@mizar/hud-view';
import { statsInserts } from './stats-inserts';
import { programPresentationSchema } from '@mizar/protocol/program-scenes';
import { ProgramScenePage } from './ProgramScenePage';
import { useLocalChannelClient } from '../realtime';

export function StatsInsertPage() {
  const [bundle, setBundle] = useState<BroadcastStats | null>(null);
  const client = useLocalChannelClient('program');
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    let active = true;
    let current: string | null = null;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/local/v1/program-presentation', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        const presentation = response.ok
          ? programPresentationSchema.parse(await response.json())
          : null;
        const matchId = presentation?.match?.matchId ?? null;
        if (!active) return;
        if (matchId !== current) {
          current = matchId;
          generation++;
          setBundle(null);
        }
        if (matchId) {
          const requestGeneration = generation;
          try {
            const stats = await fetch('/local/v1/broadcast-stats', {
              cache: 'no-store',
              signal: AbortSignal.timeout(5000),
            });
            const data = stats.ok ? await stats.json() : undefined;
            if (active && requestGeneration === generation && data === null) setBundle(null);
            const parsed = broadcastStatsSchema.safeParse(data);
            if (
              active &&
              requestGeneration === generation &&
              parsed.success &&
              parsed.data.matchId === matchId
            )
              setBundle(parsed.data);
          } catch {
            // Keep the last same-match snapshot when the local read fails.
          }
        }
      } catch {
        if (active) {
          current = null;
          generation++;
          setBundle(null);
        }
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      active = false;
      generation++;
      clearTimeout(timer);
    };
  }, []);
  const observedMatch = connection.current?.payload.match?.matchId;
  const cards =
    bundle && (!connection.current || observedMatch === bundle.matchId) ? statsInserts(bundle) : [];
  const requested = new URLSearchParams(window.location.search).get('card');
  const card = requested ? cards.find((item) => item.subtitle === requested) : cards[0];
  return card ? (
    <StatsInsertView insert={card} />
  ) : (
    <>
      <ProgramScenePage sceneId="waiting" />
      <div className="stats-insert-status">统计暂不可用</div>
    </>
  );
}
