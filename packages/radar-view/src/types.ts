/** Overview coordinates are supplied by the producer. No world calibration occurs here. */
export type RadarLayer = 'single' | 'upper' | 'lower' | 'unknown';
export interface RadarPoint {
  readonly x: number;
  readonly y: number;
  readonly layer: RadarLayer;
  readonly outOfBounds?: boolean;
  /** Optional calibrated vertical displacement, used only for local motion continuity. */
  readonly z?: number;
}
export interface RadarPlayer {
  readonly sourcePlayerId: string;
  readonly side: 'CT' | 'T' | 'unknown';
  readonly lifeState: 'alive' | 'dead' | 'unknown';
  readonly position: RadarPoint | null;
  readonly facing: { readonly x: number; readonly y: number } | null;
  readonly label?: string;
  readonly health?: number | null;
  readonly flashAmount?: number | null;
  readonly activeWeapon?: {
    readonly name: string | null;
    readonly ammoClip: number | null;
    readonly state: string | null;
    readonly firearm: boolean;
  } | null;
}
export interface RadarUtility {
  readonly sourceEntityId: string;
  readonly kind: string | null;
  readonly ownerSourceId: string | null;
  readonly position: RadarPoint | null;
  readonly lifetimeSeconds: number | null;
  readonly effectTimeSeconds: number | null;
  /** Absent on public Live: never invent local velocity. */
  readonly moving?: boolean | null;
  readonly flames: readonly { readonly sourceFlameId: string; readonly position: RadarPoint }[];
}
export interface RadarBomb {
  readonly position: RadarPoint | null;
  readonly state?: string | null;
  readonly sourcePlayerId?: string | null;
}
export interface RadarViewFrame {
  /** Host-owned continuity identity: match, authority, generation and map epoch. */
  readonly boundary: string;
  readonly sequence: number;
  /** Distinguishes new telemetry from local runtime-only publications; omit if unavailable. */
  readonly sampleSequence?: number | null;
  readonly mapName: string;
  readonly calibrationRevision: string;
  readonly layers: readonly RadarLayer[];
  readonly activeLayer: RadarLayer | null;
  /** Expected host sampling cadence, used only to detect visual discontinuity. */
  readonly sampleGapMs?: number;
  readonly payload: {
    readonly players: readonly RadarPlayer[];
    readonly bomb: RadarBomb | null;
    readonly grenades: readonly RadarUtility[];
    readonly observedPlayerSourceId?: string | null;
    /** Local replay may preserve known stationary effects; public invalid positions clear. */
    readonly retainEffectAnchors?: boolean;
    readonly playersComplete?: boolean;
  };
}
/** A synchronous, latest-value presentation input. Transport stays in the host. */
export interface RadarViewSource {
  getSnapshot(): RadarViewFrame | null;
  subscribe(listener: () => void): () => void;
}
