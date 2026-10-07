import {
  getProjectionIdentityCapabilities,
  getProjectionIdentityState,
  getProgramSafeRuntimeFreshness,
  selectProgramSafeRuntimeView,
  type ProjectionCursor,
} from '@mizar/core/projection';
import type {
  ActiveLineupResolution,
  IdentityCapabilities,
  IdentityIssue,
  IdentityResolution,
  IdentitySideMapping,
  UnresolvedObservedPlayer,
} from '@mizar/core/identity';
import type { RuntimeDisposition, RuntimeTransition } from '@mizar/core/runtime';
import type { MatchFormat } from '@mizar/core/match-context';
import type { SeriesProgress } from '@mizar/core/series-progress';

import type { MatchContextBinding } from '../match-context/index.js';
import type { CstvSourceHealth, CstvSourceManagers } from '../telemetry/cstv-source-manager.js';
import type { ProgramRuntimeSnapshot } from '../runtime/program-runtime.js';
import { projectionContextFromBinding, type ProjectionContextInput } from './context-input.js';

export interface OperatorProjection {
  readonly cursor: ProjectionCursor;
  readonly seriesProgress: null | {
    readonly bindingState: SeriesProgress['bindingState'];
    readonly requiredWins: SeriesProgress['requiredWins'];
    readonly score: SeriesProgress['score'];
    readonly currentMapOrder: number | null;
    readonly maps: readonly {
      readonly mapOrder: number;
      readonly mapName: string;
      readonly status: SeriesProgress['maps'][number]['status'];
      readonly executionMapEpoch: number | null;
      readonly finalScore: SeriesProgress['maps'][number]['finalScore'];
      readonly roundHistoryCompleteness: SeriesProgress['maps'][number]['roundHistory']['completeness'];
    }[];
    readonly issues: SeriesProgress['issues'];
  };
  readonly runtime: {
    readonly telemetryFreshness: 'awaiting' | 'fresh' | 'stale';
    readonly mapName: string | null;
    readonly lastAccepted: null | {
      readonly receiveSequence: number;
      readonly receivedAt: string;
    };
    readonly lastDisposition: RuntimeDisposition | null;
    readonly recentTransitions: readonly RuntimeTransition[];
  };
  readonly matchContext: {
    readonly state: ProjectionContextInput['state'];
    readonly summary: null | {
      readonly matchId: string;
      readonly competitionName: string;
      readonly format: MatchFormat;
      readonly entryAName: string;
      readonly entryBName: string;
    };
    readonly origin: ProjectionContextInput['origin'];
    readonly freshness: ProjectionContextInput['freshness'];
    readonly storedAt: string | null;
    readonly cachedFrom: ProjectionContextInput['cachedFrom'];
    readonly diagnostics: ProjectionContextInput['diagnostics'];
  };
  readonly identity: {
    readonly state: IdentityResolution['state'];
    readonly capabilities: IdentityCapabilities;
    readonly sideMapping: IdentitySideMapping;
    readonly issues: readonly IdentityIssue[];
    readonly resolvedCount: number;
    readonly unresolved: readonly UnresolvedObservedPlayer[];
  };
  readonly activeLineup: {
    readonly state: ActiveLineupResolution['state'];
    readonly sourceGeneration: number;
    readonly mapEpoch: number;
    readonly ctCount: number;
    readonly tCount: number;
    readonly retainedCount: number;
    readonly extras: readonly {
      readonly sourcePlayerId: string;
      readonly displayName: string | null;
      readonly side: 'CT' | 'T' | 'unknown';
      readonly activity: string | null;
    }[];
    readonly issues: ActiveLineupResolution['issues'];
  };
  readonly sources: {
    readonly cstvProgram: CstvSourceHealth;
    readonly cstvLookahead: CstvSourceHealth;
  };
}

export interface OperatorProjectionInput {
  readonly runtime: ProgramRuntimeSnapshot;
  readonly context: MatchContextBinding | undefined;
  readonly identity: IdentityResolution;
  readonly activeLineup: ActiveLineupResolution;
  readonly cstvSources: CstvSourceManagers;
  readonly nowMonotonicMs: number;
}

export function projectOperator(input: OperatorProjectionInput): OperatorProjection {
  const state = input.runtime.current;
  const safeRuntime = selectProgramSafeRuntimeView(state);
  const context = projectionContextFromBinding(input.context);
  const lastAccepted = safeRuntime.programSourceLastAccepted;
  const lineupPlayers = [...input.activeLineup.ct, ...input.activeLineup.t];
  const seriesProgress = input.runtime.seriesProgress;

  return {
    cursor: safeRuntime.cursor,
    seriesProgress:
      seriesProgress === null
        ? null
        : {
            bindingState: seriesProgress.bindingState,
            requiredWins: seriesProgress.requiredWins,
            score: { ...seriesProgress.score },
            currentMapOrder: seriesProgress.currentMapOrder,
            maps: seriesProgress.maps.map((map) => ({
              mapOrder: map.mapOrder,
              mapName: map.mapName,
              status: map.status,
              executionMapEpoch: map.executionMapEpoch,
              finalScore: map.finalScore === null ? null : { ...map.finalScore },
              roundHistoryCompleteness: map.roundHistory.completeness,
            })),
            issues: seriesProgress.issues.map((item) => ({ ...item })),
          },
    runtime: {
      telemetryFreshness: getProgramSafeRuntimeFreshness(
        safeRuntime,
        input.nowMonotonicMs,
        input.runtime.continuityPolicy,
      ),
      mapName: safeRuntime.telemetry?.telemetry.map?.name ?? null,
      lastAccepted:
        lastAccepted === null
          ? null
          : {
              receiveSequence: safeRuntime.cursor.programReceiveSequence ?? 0,
              receivedAt: lastAccepted.receivedAt,
            },
      lastDisposition: input.runtime.lastDisposition ?? null,
      recentTransitions: input.runtime.recentTransitions.slice(),
    },
    matchContext: {
      state: context.state,
      summary:
        context.context === undefined
          ? null
          : {
              matchId: context.context.matchId,
              competitionName: context.context.competition?.name ?? '',
              format: context.context.format,
              entryAName: context.context.entrants.a.name,
              entryBName: context.context.entrants.b.name,
            },
      origin: context.origin,
      freshness: context.freshness,
      storedAt: context.storedAt,
      cachedFrom: context.cachedFrom,
      diagnostics: context.diagnostics.slice(),
    },
    identity: {
      state: getProjectionIdentityState(safeRuntime, input.identity),
      capabilities: getProjectionIdentityCapabilities(safeRuntime, input.identity),
      sideMapping: { ...input.identity.sideMapping },
      issues: input.identity.issues.map((issue) => ({ ...issue })),
      resolvedCount: input.identity.players.length,
      unresolved: input.identity.unresolved.map((player) => ({ ...player })),
    },
    activeLineup: {
      state: input.activeLineup.state,
      sourceGeneration: input.activeLineup.sourceGeneration,
      mapEpoch: input.activeLineup.mapEpoch,
      ctCount: input.activeLineup.ct.length,
      tCount: input.activeLineup.t.length,
      retainedCount: lineupPlayers.filter((player) => player.lineupEvidence === 'retained').length,
      extras: input.activeLineup.extras.map((player) => ({
        sourcePlayerId: player.sourcePlayerId,
        displayName: player.displayName ?? null,
        side: player.side ?? 'unknown',
        activity: player.activity ?? null,
      })),
      issues: input.activeLineup.issues.map((issue) => ({ ...issue })),
    },
    sources: {
      cstvProgram: { ...input.cstvSources.program.getHealth() },
      cstvLookahead: { ...input.cstvSources.lookahead.getHealth() },
    },
  };
}
