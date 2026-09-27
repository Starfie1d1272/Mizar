import type { OperatorPayload } from '@mizar/protocol/operator';

import type { OperatorProjection } from '../projections/operator-projection.js';

function optionalNumber(value: number | undefined): number | null {
  return value ?? null;
}

function transitionBase(transition: OperatorProjection['runtime']['recentTransitions'][number]) {
  return {
    runtimeSeq: transition.runtimeSeq,
    producerInstanceId: transition.producerInstanceId,
    liveSession:
      transition.liveSession.kind === 'bound'
        ? { kind: 'bound' as const, liveSessionId: transition.liveSession.liveSessionId }
        : { kind: 'unbound' as const },
    mapEpoch: transition.mapEpoch,
    at: { ...transition.at },
  };
}

function optionalString(value: string | undefined): string | null {
  return value ?? null;
}

function assertNever(value: never): never {
  throw new Error(`unhandled RuntimeTransition kind: ${String(value)}`);
}

function mapTransition(
  transition: OperatorProjection['runtime']['recentTransitions'][number],
): OperatorPayload['runtime']['recentTransitions'][number] {
  switch (transition.kind) {
    case 'round_started':
      return {
        ...transitionBase(transition),
        kind: transition.kind,
        sourceGeneration: transition.sourceGeneration,
        receiveSequence: transition.receiveSequence,
        roundNumber: optionalNumber(transition.roundNumber),
      };
    case 'round_ended':
      return {
        ...transitionBase(transition),
        kind: transition.kind,
        sourceGeneration: transition.sourceGeneration,
        receiveSequence: transition.receiveSequence,
        roundNumber: optionalNumber(transition.roundNumber),
        winnerSide: transition.winnerSide ?? null,
      };
    case 'map_ended':
      return {
        ...transitionBase(transition),
        kind: transition.kind,
        sourceGeneration: transition.sourceGeneration,
        receiveSequence: transition.receiveSequence,
      };
    case 'map_execution_changed':
      switch (transition.reason) {
        case 'observed-map-name-change':
          return {
            ...transitionBase(transition),
            kind: transition.kind,
            reason: transition.reason,
            sourceGeneration: transition.sourceGeneration,
            receiveSequence: transition.receiveSequence,
            previousMapEpoch: transition.previousMapEpoch,
            previousMapName: optionalString(transition.previousMapName),
            mapName: optionalString(transition.mapName),
          };
        case 'explicit-reset':
          return {
            ...transitionBase(transition),
            kind: transition.kind,
            reason: transition.reason,
            resetReason: transition.resetReason,
            previousMapEpoch: transition.previousMapEpoch,
            previousMapName: optionalString(transition.previousMapName),
            mapName: optionalString(transition.mapName),
          };
        default:
          return assertNever(transition);
      }
    default:
      return assertNever(transition);
  }
}

function mapDisposition(
  disposition: OperatorProjection['runtime']['lastDisposition'],
): OperatorPayload['runtime']['lastDisposition'] {
  if (disposition === null) return null;
  return {
    kind: disposition.kind,
    reason: disposition.reason,
    missingSequenceRange:
      'missingSequenceRange' in disposition && disposition.missingSequenceRange !== undefined
        ? { ...disposition.missingSequenceRange }
        : null,
  };
}

function mapSourceHealth(
  health: OperatorProjection['sources']['cstvProgram'],
): OperatorPayload['sources']['cstvProgram'] {
  return {
    role: health.role,
    state: health.state,
    generation: health.generation,
    reconnectAttempt: health.reconnectAttempt,
    lastSync:
      health.lastSync === undefined
        ? null
        : {
            protocol: health.lastSync.protocol,
            tick: health.lastSync.tick,
            ticksPerSecond: health.lastSync.ticksPerSecond,
            fragment: health.lastSync.fragment,
            signupFragment: health.lastSync.signupFragment,
            mapName: health.lastSync.mapName ?? null,
            realTimeDelaySeconds: health.lastSync.realTimeDelaySeconds ?? null,
            receiveAgeSeconds: health.lastSync.receiveAgeSeconds ?? null,
          },
    tailTick: health.tailTick ?? null,
    lastEventTick: health.lastEventTick ?? null,
    lastEventSequence: health.lastEventSequence ?? null,
    lastEventObservedAt: health.lastEventObservedAt ?? null,
    lastErrorCode: health.lastErrorCode ?? null,
    lastTerminalStatus: health.lastTerminalStatus ?? null,
  };
}

export function mapOperatorProjection(projection: OperatorProjection): OperatorPayload {
  return {
    seriesProgress:
      projection.seriesProgress === null
        ? null
        : {
            bindingState: projection.seriesProgress.bindingState,
            requiredWins: projection.seriesProgress.requiredWins,
            score: { ...projection.seriesProgress.score },
            currentMapOrder: projection.seriesProgress.currentMapOrder,
            maps: projection.seriesProgress.maps.map((map) => ({
              mapOrder: map.mapOrder,
              mapName: map.mapName,
              status: map.status,
              executionMapEpoch: map.executionMapEpoch,
              finalScore: map.finalScore === null ? null : { ...map.finalScore },
              roundHistoryCompleteness: map.roundHistoryCompleteness,
            })),
            issues: projection.seriesProgress.issues.map((item) => ({ ...item })),
          },
    runtime: {
      telemetryFreshness: projection.runtime.telemetryFreshness,
      mapName: projection.runtime.mapName,
      lastAccepted: projection.runtime.lastAccepted,
      lastDisposition: mapDisposition(projection.runtime.lastDisposition),
      recentTransitions: projection.runtime.recentTransitions.map(mapTransition),
    },
    matchContext: {
      state: projection.matchContext.state,
      summary: projection.matchContext.summary,
      origin: projection.matchContext.origin,
      freshness: projection.matchContext.freshness,
      storedAt: projection.matchContext.storedAt,
      cachedFrom: projection.matchContext.cachedFrom,
      diagnostics: projection.matchContext.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    },
    identity: {
      state: projection.identity.state,
      capabilities: projection.identity.capabilities,
      sideMapping: projection.identity.sideMapping,
      issues: projection.identity.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        sourcePlayerId: issue.sourcePlayerId ?? null,
        steam64: issue.steam64 ?? null,
        canonicalPlayerId: issue.canonicalPlayerId ?? null,
        entryId: issue.entryId ?? null,
        observedSide: issue.observedSide ?? null,
        mapSide: issue.mapSide ?? null,
      })),
      resolvedCount: projection.identity.resolvedCount,
      unresolved: projection.identity.unresolved.map((player) => ({
        sourcePlayerId: player.sourcePlayerId,
        displayName: player.displayName,
        side: player.side,
        observerSlot: player.observerSlot,
      })),
    },
    activeLineup: {
      state: projection.activeLineup.state,
      sourceGeneration: projection.activeLineup.sourceGeneration,
      mapEpoch: projection.activeLineup.mapEpoch,
      ctCount: projection.activeLineup.ctCount,
      tCount: projection.activeLineup.tCount,
      retainedCount: projection.activeLineup.retainedCount,
      extras: projection.activeLineup.extras.map((player) => ({ ...player })),
      issues: projection.activeLineup.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        sourcePlayerId: issue.sourcePlayerId ?? null,
        side: issue.side ?? null,
      })),
    },
    sources: {
      cstvProgram: mapSourceHealth(projection.sources.cstvProgram),
      cstvLookahead: mapSourceHealth(projection.sources.cstvLookahead),
    },
  };
}
