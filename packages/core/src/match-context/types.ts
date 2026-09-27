import type { SourceSide } from '../telemetry/map.js';

export type MatchStatus = 'scheduled' | 'in_progress' | 'finished' | 'cancelled';

export type MatchFormat = 'bo1' | 'bo3' | 'bo5';

export type MatchSide = Exclude<SourceSide, 'unknown'>;

export type MatchVetoActionType = 'ban' | 'pick' | 'side_pick' | 'decider';

export interface MatchCompetitionContext {
  readonly competitionId: string;
  readonly slug: string;
  readonly name: string;
  readonly themeColor: string | null;
}

export interface MatchPlayerContext {
  readonly playerId: string;
  readonly steam64: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly isStarter: boolean;
}

export interface MatchEntrantContext {
  readonly entryId: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly rosterId: string | null;
  readonly players: readonly MatchPlayerContext[];
}

export interface MatchMapContext {
  readonly mapId: string;
  readonly mapOrder: number;
  readonly mapName: string;
  readonly pickedByEntryId: string | null;
  readonly teamAStartSide: MatchSide | null;
  readonly scoreA: number | null;
  readonly scoreB: number | null;
  readonly completedAt: string | null;
}

export interface MatchVetoStepContext {
  readonly stepOrder: number;
  readonly actionType: MatchVetoActionType;
  readonly mapName: string;
  readonly entryId: string | null;
  readonly side: MatchSide | null;
}

export interface MatchCommentatorContext {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly liveStreamUrl: string | null;
}

/**
 * Broadcast's provider-neutral domain model for one selected RivalHub match.
 * Acquisition metadata such as revision, schema version, and cache origin is
 * intentionally kept outside this model.
 */
export interface MatchContext {
  readonly matchId: string;
  readonly competition: MatchCompetitionContext;
  readonly status: MatchStatus;
  readonly format: MatchFormat;
  readonly stage: string;
  readonly round: number | null;
  readonly entryRound: string | null;
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly scoreA: number | null;
  readonly scoreB: number | null;
  readonly isForfeit: boolean;
  readonly entrants: {
    readonly a: MatchEntrantContext;
    readonly b: MatchEntrantContext;
  };
  readonly maps: readonly MatchMapContext[];
  readonly veto: readonly MatchVetoStepContext[];
  readonly commentators: readonly MatchCommentatorContext[];
}

export interface ScheduleMatchContext {
  readonly matchId: string;
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly status: MatchStatus;
  readonly format: MatchFormat;
  readonly stage: string;
  readonly round: number | null;
  readonly isForfeit: boolean;
  readonly scoreA: number | null;
  readonly scoreB: number | null;
  readonly entrants: {
    readonly a: Pick<MatchEntrantContext, 'entryId' | 'name' | 'logoUrl'>;
    readonly b: Pick<MatchEntrantContext, 'entryId' | 'name' | 'logoUrl'>;
  };
}

/** Mizar-owned lightweight time-window domain model. */
export interface ScheduleWindow {
  readonly competition: MatchCompetitionContext;
  readonly from: string;
  readonly to: string;
  readonly matches: readonly ScheduleMatchContext[];
}
