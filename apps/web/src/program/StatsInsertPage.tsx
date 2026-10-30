import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  broadcastStatsProgramSchema,
  type BroadcastStatsProgram,
} from '@mizar/protocol/broadcast-stats-presentation';
import { StatsInsertView } from '@mizar/hud-view';
import { statsProgramInserts } from './stats-program';
import { programPresentationSchema } from '@mizar/protocol/program-scenes';
import { ProgramScenePage } from './ProgramScenePage';
import { useLocalChannelClient } from '../realtime';
import { useProgramScenes } from '../workspace/client';
import { useBroadcastDisplayConfig } from '../realtime/broadcast-display-client';
import { pulseTokenStyle } from './broadcast-display';

export function StatsInsertPage() {
  const [bundle, setBundle] = useState<BroadcastStatsProgram | null>(null);
  const scenes = useProgramScenes();
  const sceneId = scenes?.active === 'intermap' ? 'intermap' : 'waiting';
  const display = useBroadcastDisplayConfig(true, sceneId);
  const client = useLocalChannelClient('program');
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    let active = true;
    let current: string | null = null;
    let generation = 0;
    let presentationRequest = 0;
    let acceptedPresentation = 0;
    let statsRequest = 0;
    const poll = async () => {
      const request = ++presentationRequest;
      try {
        const response = await fetch('/local/v1/program-presentation', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        const presentation = response.ok
          ? programPresentationSchema.parse(await response.json())
          : null;
        const matchId = presentation?.match?.matchId ?? null;
        if (!active || request < acceptedPresentation) return;
        acceptedPresentation = request;
        if (matchId !== current) {
          current = matchId;
          generation++;
          setBundle(null);
        }
        if (matchId) {
          const requestGeneration = generation;
          const statsSequence = ++statsRequest;
          try {
            const stats = await fetch('/local/v1/broadcast-stats-program', {
              cache: 'no-store',
              signal: AbortSignal.timeout(5000),
            });
            const data = stats.ok ? await stats.json() : undefined;
            if (
              active &&
              requestGeneration === generation &&
              statsSequence === statsRequest &&
              data === null
            )
              setBundle(null);
            const parsed = broadcastStatsProgramSchema.safeParse(data);
            if (
              active &&
              requestGeneration === generation &&
              statsSequence === statsRequest &&
              parsed.success &&
              parsed.data.matchId === matchId
            )
              setBundle(parsed.data);
          } catch {
            // Keep the last same-match snapshot when the local read fails.
          }
        }
      } catch {
        if (active && request >= acceptedPresentation) {
          acceptedPresentation = request;
          current = null;
          generation++;
          setBundle(null);
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      generation++;
      clearInterval(timer);
    };
  }, []);
  const observedMatch = connection.current?.payload.match?.matchId;
  const cards =
    bundle && (!connection.current || observedMatch === bundle.matchId)
      ? statsProgramInserts(bundle, new URLSearchParams(window.location.search).get('player'))
      : [];
  const requested = new URLSearchParams(window.location.search).get('card');
  const legacyIds: Record<string, string> = {
    'MAP PERFORMANCE': 'maps',
    'RECENT MAPS': 'recent',
    'PISTOL & CONVERSION': 'economy',
    pistol: 'economy',
    ECONOMY: 'conversion',
    UTILITY: 'utility',
    LINEUPS: 'lineup',
    lineups: 'lineup',
    'PLAYER COMPARISON': 'players',
    'player-comparison': 'players',
    'PLAYER ATTRIBUTES': 'radar',
    'player-attributes': 'radar',
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
