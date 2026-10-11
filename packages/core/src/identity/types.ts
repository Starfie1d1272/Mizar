import type { MapPhase, SourceSide } from '../telemetry/map.js';
import type { ObservedPlayer, TelemetryCoverageStatus } from '../telemetry/index.js';

export type IdentityState = 'unbound' | 'resolving' | 'matched' | 'degraded' | 'mismatch';

export type IdentityIssueSeverity = 'info' | 'warning' | 'error';

export type IdentityIssueCode =
  | 'context_unbound'
  | 'roster_evidence_pending'
  | 'allplayers_unavailable'
  | 'allplayers_degraded'
  | 'partial_roster_evidence'
  | 'source_generation_changed'
  | 'map_epoch_changed'
  | 'roster_incomplete'
  | 'missing_canonical_steam64'
  | 'missing_canonical_display_name'
  | 'duplicate_canonical_player_id'
  | 'duplicate_canonical_steam64'
  | 'bot_or_noncanonical_source_id'
  | 'unexpected_human_steam64'
  | 'duplicate_observed_identity'
  | 'unknown_observed_side'
  | 'ambiguous_side_mapping'
  | 'side_mapping_conflict'
  | 'lineup_differs_from_expected'
  | 'map_not_confirmed'
  | 'map_mismatch';

export interface IdentityIssue {
  readonly code: IdentityIssueCode;
  readonly severity: IdentityIssueSeverity;
  readonly message: string;
  readonly sourcePlayerId?: string;
  readonly steam64?: string;
  readonly canonicalPlayerId?: string;
  /** Canonical missing-account record is an expected starter; independent of map/health state. */
  readonly affectsExpectedLineup?: boolean;
  readonly entryId?: string;
  readonly observedSide?: SourceSide;
  readonly mapSide?: SourceSide;
}

export interface IdentityObservationInput {
  readonly sourceGeneration: number;
  readonly mapEpoch: number;
  readonly allPlayers?: readonly ObservedPlayer[];
  readonly allPlayersCoverage?: TelemetryCoverageStatus;
  readonly mapName?: string;
  readonly mapPhase?: MapPhase;
  readonly mapSideNames?: {
    readonly ct?: string;
    readonly t?: string;
  };
}

export interface ResolvedIdentityPlayer {
  readonly canonicalPlayerId: string;
  readonly entryId: string;
  readonly steam64: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly isStarter: boolean;
  readonly sourcePlayerId: string | null;
  readonly observedDisplayName: string | null;
  readonly observerSlot: number | null;
  readonly side: SourceSide;
  readonly evidence: 'current' | 'retained';
}

export interface UnresolvedObservedPlayer {
  readonly sourcePlayerId: string;
  readonly displayName: string | null;
  readonly side: SourceSide;
  readonly observerSlot: number | null;
}

export interface IdentitySideMapping {
  readonly a: SourceSide;
  readonly b: SourceSide;
}

export interface IdentityCapabilities {
  /** A partial mapping may still be used by diagnostics and local presentation. */
  readonly canonicalPlayerMapping: boolean;
  /** Branding may survive a soft player mismatch when current side proof is complete. */
  readonly canonicalTeamBranding: boolean;
  /** Automatic identity-dependent result behavior is fail-closed. */
  readonly identityDependentResult: boolean;
  /** Neutral telemetry remains available even when identity is mismatched. */
  readonly neutralTelemetry: boolean;
}

export interface IdentityResolution {
  readonly state: IdentityState;
  readonly sourceGeneration: number;
  readonly mapEpoch: number;
  readonly players: readonly ResolvedIdentityPlayer[];
  readonly unresolved: readonly UnresolvedObservedPlayer[];
  readonly sideMapping: IdentitySideMapping;
  readonly issues: readonly IdentityIssue[];
  readonly capabilities: IdentityCapabilities;
}
