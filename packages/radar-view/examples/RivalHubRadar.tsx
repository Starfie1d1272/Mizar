'use client';

import { fromPublicRadar, RadarView } from '@mizar-hud/radar-view';
import '@mizar-hud/radar-view/radar.css';
import type { PublicLiveMatchProjection } from './public-live-projection.js';

/** The page's existing acceptance/freshness owner supplies only accepted projections. */
export function RivalHubRadar({
  live,
  status,
  resetRevision = 0,
}: {
  readonly live: PublicLiveMatchProjection | null;
  readonly status: 'fresh' | 'stale' | 'unavailable';
  readonly resetRevision?: number;
}) {
  const frame =
    live === null
      ? null
      : fromPublicRadar(live.radar, {
          boundary: JSON.stringify([
            live.matchId,
            live.delivery.authorityRevision,
            live.delivery.generation,
            live.delivery.epoch,
          ]),
          sequence: live.delivery.sequence,
          current:
            status !== 'unavailable' &&
            live.capability.radarCurrent &&
            live.capability.identity !== 'mismatch',
          bomb: live.bomb,
        });
  return (
    <RadarView
      snapshot={frame}
      paused={status === 'stale'}
      presentationRevision={resetRevision}
      assetBaseUrl="/vendor/radar/0.1.0"
    />
  );
}
