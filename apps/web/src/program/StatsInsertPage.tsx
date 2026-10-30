import { useEffect, useState, useSyncExternalStore } from 'react';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import { StatsInsertView } from '@mizar/hud-view';
import { statsInserts } from './stats-inserts';
import { programPresentationSchema } from '@mizar/protocol/program-scenes';
import { ProgramScenePage } from './ProgramScenePage';
import { useLocalChannelClient } from '../realtime';
import { useProgramScenes } from '../workspace/client';
import { useBroadcastDisplayConfig } from '../realtime/broadcast-display-client';
import { pulseTokenStyle } from './broadcast-display';

export function StatsInsertPage() {
  const [bundle, setBundle] = useState<BroadcastStats | null>(null);
  const scenes = useProgramScenes();
  const sceneId = scenes?.active === 'intermap' ? 'intermap' : 'waiting';
  const display = useBroadcastDisplayConfig(true, sceneId);
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
  const legacyIds: Record<string, string> = {
    'MAP PERFORMANCE': 'maps',
    'RECENT MAPS': 'recent',
    'PISTOL & CONVERSION': 'pistol',
    ECONOMY: 'economy',
    UTILITY: 'utility',
    LINEUPS: 'lineups',
    'PLAYER COMPARISON': 'player-comparison',
    'PLAYER ATTRIBUTES': 'player-attributes',
  };
  const id = requested ? (legacyIds[requested] ?? requested) : null;
  const card = id ? cards.find((item) => item.id === id) : cards[0];
  if (card && !display.current) return null;
  return card ? (
    <StatsInsertView
      insert={card}
      sceneStyle={pulseTokenStyle(display.current!.program) ?? undefined}
    />
  ) : (
    <>
      <ProgramScenePage sceneId="waiting" />
      <div className="stats-insert-status">统计暂不可用</div>
    </>
  );
}
