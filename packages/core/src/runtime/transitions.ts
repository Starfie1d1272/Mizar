import type { ProgramTelemetryInput } from './continuity.js';
import type {
  ExplicitMapExecutionChangedTransition,
  MapExecutionChangedTransitionBase,
  MapExecutionResetReason,
  MapEndedTransition,
  ObservedMapExecutionChangedTransition,
  ProgramTelemetryTransitionBase,
  RoundEndedTransition,
  RoundStartedTransition,
  RuntimeState,
  RuntimeTime,
  RuntimeTransition,
  RuntimeTransitionBase,
  LiveSessionBinding,
} from './types.js';

export const NO_TRANSITIONS: readonly RuntimeTransition[] = [];

function copyLiveSession(liveSession: LiveSessionBinding): LiveSessionBinding {
  return liveSession.kind === 'bound'
    ? { kind: 'bound', liveSessionId: liveSession.liveSessionId }
    : { kind: 'unbound' };
}

function copyRuntimeTime(at: RuntimeTime): RuntimeTime {
  return { monotonicMs: at.monotonicMs, utc: at.utc };
}

function transitionBase(
  state: RuntimeState,
  runtimeSeq: number,
  mapEpoch: number,
  at: RuntimeTime,
): RuntimeTransitionBase {
  return {
    runtimeSeq,
    producerInstanceId: state.producerInstanceId,
    liveSession: copyLiveSession(state.liveSession),
    mapEpoch,
    at: copyRuntimeTime(at),
  };
}

function programTransitionBase(
  state: RuntimeState,
  nextRuntimeSeq: number,
  nextMapEpoch: number,
  input: ProgramTelemetryInput,
): ProgramTelemetryTransitionBase {
  return {
    ...transitionBase(state, nextRuntimeSeq, nextMapEpoch, {
      monotonicMs: input.observation.receive.receivedMonotonicMs,
      utc: input.observation.receive.receivedAt,
    }),
    sourceGeneration: input.sourceGeneration,
    receiveSequence: input.observation.receive.sequence,
  };
}

function hasRoundPhase(
  state: RuntimeState | undefined,
  phase: 'freezetime' | 'live' | 'over',
): boolean {
  return (
    state?.programTelemetry !== undefined &&
    state.programTelemetry.coverage.round === 'present' &&
    state.programTelemetry.telemetry.round?.phase === phase
  );
}

function hasCurrentRoundPhase(
  input: ProgramTelemetryInput,
  phase: 'freezetime' | 'live' | 'over',
): boolean {
  return (
    input.observation.coverage.round === 'present' &&
    input.observation.telemetry.round?.phase === phase
  );
}

function hasKnownMapPhase(state: RuntimeState | undefined, phase: 'gameover'): boolean {
  return (
    state?.programTelemetry !== undefined &&
    state.programTelemetry.coverage.map === 'present' &&
    state.programTelemetry.telemetry.map?.phase !== undefined &&
    state.programTelemetry.telemetry.map.phase !== 'unknown' &&
    state.programTelemetry.telemetry.map.phase !== phase
  );
}

function hasCurrentMapPhase(input: ProgramTelemetryInput, phase: 'gameover'): boolean {
  return (
    input.observation.coverage.map === 'present' && input.observation.telemetry.map?.phase === phase
  );
}

function roundStartedTransition(
  state: RuntimeState,
  nextRuntimeSeq: number,
  nextMapEpoch: number,
  input: ProgramTelemetryInput,
): RoundStartedTransition {
  const base = programTransitionBase(state, nextRuntimeSeq, nextMapEpoch, input);
  const roundNumber = input.observation.telemetry.map?.roundNumber;
  return {
    kind: 'round_started',
    ...base,
    ...(roundNumber === undefined ? {} : { roundNumber }),
  };
}

function roundEndedTransition(
  state: RuntimeState,
  nextRuntimeSeq: number,
  nextMapEpoch: number,
  input: ProgramTelemetryInput,
): RoundEndedTransition {
  const base = programTransitionBase(state, nextRuntimeSeq, nextMapEpoch, input);
  const round = input.observation.telemetry.round;
  const roundNumber = input.observation.telemetry.map?.roundNumber;
  return {
    kind: 'round_ended',
    ...base,
    ...(roundNumber === undefined ? {} : { roundNumber }),
    ...(round?.winnerSide === undefined ? {} : { winnerSide: round.winnerSide }),
  };
}

function mapEndedTransition(
  state: RuntimeState,
  nextRuntimeSeq: number,
  nextMapEpoch: number,
  input: ProgramTelemetryInput,
): MapEndedTransition {
  return {
    kind: 'map_ended',
    ...programTransitionBase(state, nextRuntimeSeq, nextMapEpoch, input),
  };
}

function mapExecutionChangedTransitionBase(
  state: RuntimeState,
  nextState: RuntimeState,
  at: RuntimeTime,
): MapExecutionChangedTransitionBase {
  return {
    kind: 'map_execution_changed',
    ...transitionBase(state, nextState.runtimeSeq, nextState.map.epoch, at),
    previousMapEpoch: state.map.epoch,
    ...(state.map.name === undefined ? {} : { previousMapName: state.map.name }),
    ...(nextState.map.name === undefined ? {} : { mapName: nextState.map.name }),
  };
}

export function observedMapExecutionChangedTransition(
  state: RuntimeState,
  nextState: RuntimeState,
  input: ProgramTelemetryInput,
  reason: ObservedMapExecutionChangedTransition['reason'] = 'observed-map-name-change',
): ObservedMapExecutionChangedTransition {
  return {
    ...mapExecutionChangedTransitionBase(state, nextState, {
      monotonicMs: input.observation.receive.receivedMonotonicMs,
      utc: input.observation.receive.receivedAt,
    }),
    reason,
    sourceGeneration: input.sourceGeneration,
    receiveSequence: input.observation.receive.sequence,
  };
}

export function explicitMapExecutionChangedTransition(
  state: RuntimeState,
  nextState: RuntimeState,
  at: RuntimeTime,
  resetReason: MapExecutionResetReason,
): ExplicitMapExecutionChangedTransition {
  return {
    ...mapExecutionChangedTransitionBase(state, nextState, at),
    reason: 'explicit-reset',
    resetReason,
  };
}

export function buildTelemetryTransitions(
  state: RuntimeState,
  nextState: RuntimeState,
  input: ProgramTelemetryInput,
  sequenceIsContiguous: boolean,
  staleRecovery: boolean,
): readonly RuntimeTransition[] {
  const belongsToEstablishedMapExecution =
    state.map.epoch > 0 && nextState.map.epoch === state.map.epoch;
  if (
    !sequenceIsContiguous ||
    staleRecovery ||
    state.programTelemetry === undefined ||
    !belongsToEstablishedMapExecution
  ) {
    return NO_TRANSITIONS;
  }

  const transitions: RuntimeTransition[] = [];
  if (hasRoundPhase(state, 'freezetime') && hasCurrentRoundPhase(input, 'live')) {
    transitions.push(
      roundStartedTransition(state, nextState.runtimeSeq, nextState.map.epoch, input),
    );
  }
  if (hasRoundPhase(state, 'live') && hasCurrentRoundPhase(input, 'over')) {
    transitions.push(roundEndedTransition(state, nextState.runtimeSeq, nextState.map.epoch, input));
  }
  if (hasKnownMapPhase(state, 'gameover') && hasCurrentMapPhase(input, 'gameover')) {
    transitions.push(mapEndedTransition(state, nextState.runtimeSeq, nextState.map.epoch, input));
  }
  return transitions;
}
