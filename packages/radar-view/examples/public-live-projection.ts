import type { PublicRadarInput, RadarBomb } from '@mizar/radar-view';
/** Example-only structural seam; consumer-smoke replaces this with RivalHub's actual type. */
export interface PublicLiveMatchProjection {
  readonly matchId: string;
  readonly delivery: {
    readonly authorityRevision: number;
    readonly generation: number;
    readonly epoch: number;
    readonly sequence: number;
  };
  readonly radar: PublicRadarInput | null;
  readonly bomb: Pick<RadarBomb, 'state' | 'sourcePlayerId'> | null;
  readonly capability: { readonly radarCurrent: boolean; readonly identity: string };
}
