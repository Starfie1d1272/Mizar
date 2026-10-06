import { assertRuntimeContinuityPolicy } from './freshness.js';
import { classifyProgramTelemetry, type ProgramTelemetryInput } from './continuity.js';
import {
  createMapPlayerStatsAccumulator,
  invalidateMapPlayerStats,
  reduceMapPlayerStats,
} from './player-stats.js';
import { createObjectiveTimingState, reduceObjectiveTiming } from './objective-timing.js';
import {
  buildTelemetryTransitions,
  explicitMapExecutionChangedTransition,
  NO_TRANSITIONS,
  observedMapExecutionChangedTransition,
} from './transitions.js';
import type {
  RuntimeContinuityPolicy,
  RuntimeDisposition,
  RuntimeInput,
  RuntimeReduceResult,
  RuntimeState,
  RuntimeTime,
} from './types.js';

type GenerationAdvanceInput = Extract<
  RuntimeInput,
  { readonly kind: 'advance-program-source-generation' }
>;
type MapResetInput = Extract<RuntimeInput, { readonly kind: 'reset-map-execution' }>;
type AcceptedDisposition = Extract<RuntimeDisposition, { readonly kind: 'accepted' }>;
type IgnoredReason = Extract<RuntimeDisposition, { readonly kind: 'ignored' }>['reason'];

function ignored(state: RuntimeState, reason: IgnoredReason): RuntimeReduceResult {
  return {
    state,
    transitions: NO_TRANSITIONS,
    disposition: { kind: 'ignored', reason },
  };
}

function accepted(
  state: RuntimeState,
  disposition: AcceptedDisposition,
  transitions: RuntimeReduceResult['transitions'] = NO_TRANSITIONS,
): RuntimeReduceResult {
  return { state, transitions, disposition };
}

function assertRuntimeTime(at: RuntimeTime): void {
  if (!Number.isFinite(at.monotonicMs)) {
    throw new RangeError('RuntimeTime.monotonicMs must be a finite number');
  }
}

function knownMapName(input: ProgramTelemetryInput): string | undefined {
  if (input.observation.coverage.map !== 'present') return undefined;
  const name = input.observation.telemetry.map?.name;
  return name !== undefined && name.trim().length > 0 ? name : undefined;
}

function mapNameChanged(state: RuntimeState, mapName: string | undefined): boolean {
  return (
    mapName !== undefined &&
    state.map.epoch > 0 &&
    state.map.name !== undefined &&
    state.map.name !== mapName
  );
}

function nextMapState(
  state: RuntimeState,
  input: ProgramTelemetryInput,
): {
  readonly map: RuntimeState['map'];
  readonly changed: boolean;
  readonly reason?: 'observed-same-map-restart';
} {
  const mapName = knownMapName(input);
  if (state.map.epoch === 0 && mapName !== undefined) {
    return { map: { epoch: 1, name: mapName }, changed: false };
  }

  if (mapName !== undefined && mapNameChanged(state, mapName)) {
    return {
      map: { epoch: state.map.epoch + 1, name: mapName },
      changed: true,
    };
  }

  const map = input.observation.telemetry.map;
  if (
    mapName !== undefined &&
    mapName === state.map.name &&
    state.map.competitiveObserved === true &&
    map?.phase === 'warmup' &&
    map.roundNumber === 0 &&
    map.sides?.ct?.score === 0 &&
    map.sides.t?.score === 0 &&
    map.roundWins?.length === 0
  ) {
    return {
      map: { epoch: state.map.epoch + 1, name: mapName },
      changed: true,
      reason: 'observed-same-map-restart',
    };
  }

  if (state.map.name === undefined && mapName !== undefined) {
    return { map: { ...state.map, name: mapName }, changed: false };
  }

  return { map: state.map, changed: false };
}

function acceptedTelemetryDisposition(
  decision: Extract<ReturnType<typeof classifyProgramTelemetry>, { readonly kind: 'accepted' }>,
): AcceptedDisposition {
  if (decision.staleRecovery) {
    return {
      kind: 'accepted',
      reason: 'stale-recovery',
      ...(decision.missingSequenceRange === undefined
        ? {}
        : { missingSequenceRange: decision.missingSequenceRange }),
    };
  }

  if (decision.sequenceReason === 'gap-resync') {
    return {
      kind: 'accepted',
      reason: 'gap-resync',
      ...(decision.missingSequenceRange === undefined
        ? {}
        : { missingSequenceRange: decision.missingSequenceRange }),
    };
  }

  return { kind: 'accepted', reason: decision.sequenceReason };
}

function reduceProgramTelemetry(
  state: RuntimeState,
  input: ProgramTelemetryInput,
  policy: RuntimeContinuityPolicy,
): RuntimeReduceResult {
  const continuity = classifyProgramTelemetry(state, input, policy);
  if (continuity.kind === 'ignored') return ignored(state, continuity.reason);

  const currentGeneration = state.programSource.generation;
  const mapResult = nextMapState(state, input);
  const currentMap = input.observation.telemetry.map;
  const competitiveObserved =
    input.observation.coverage.map === 'present' &&
    knownMapName(input) === mapResult.map.name &&
    (currentMap?.phase === 'live' ||
      currentMap?.phase === 'intermission' ||
      currentMap?.phase === 'gameover');
  const nextState: RuntimeState = {
    producerInstanceId: state.producerInstanceId,
    liveSession: state.liveSession,
    runtimeSeq: state.runtimeSeq + 1,
    programSource: {
      kind: 'cs2-gsi',
      generation: currentGeneration,
      lastAccepted: {
        generation: currentGeneration,
        sequence: input.observation.receive.sequence,
        receivedAt: input.observation.receive.receivedAt,
        receivedMonotonicMs: input.observation.receive.receivedMonotonicMs,
      },
    },
    map: competitiveObserved ? { ...mapResult.map, competitiveObserved: true } : mapResult.map,
    playerStats: reduceMapPlayerStats(state.playerStats, {
      mapEpoch: mapResult.map.epoch,
      observation: input.observation,
      continuity: continuity.staleRecovery ? 'stale-recovery' : continuity.sequenceReason,
    }),
    objectiveTiming: reduceObjectiveTiming(
      state.objectiveTiming,
      input.observation,
      currentGeneration,
      mapResult.map.epoch,
      continuity.staleRecovery ? 'stale-recovery' : continuity.sequenceReason,
    ),
    programTelemetry: input.observation,
  };

  const transitions = mapResult.changed
    ? [observedMapExecutionChangedTransition(state, nextState, input, mapResult.reason)]
    : buildTelemetryTransitions(
        state,
        nextState,
        input,
        continuity.sequenceReason === 'contiguous',
        continuity.staleRecovery,
      );

  return accepted(nextState, acceptedTelemetryDisposition(continuity), transitions);
}

function reduceGenerationAdvance(
  state: RuntimeState,
  input: GenerationAdvanceInput,
): RuntimeReduceResult {
  assertRuntimeTime(input.at);
  if (input.nextGeneration !== state.programSource.generation + 1) {
    return ignored(state, 'invalid-generation-advance');
  }

  const nextState: RuntimeState = {
    producerInstanceId: state.producerInstanceId,
    liveSession: state.liveSession,
    runtimeSeq: state.runtimeSeq + 1,
    programSource: {
      ...state.programSource,
      generation: input.nextGeneration,
    },
    map: state.map,
    playerStats: invalidateMapPlayerStats(state.playerStats),
    objectiveTiming: createObjectiveTimingState(input.nextGeneration, state.map.epoch),
  };
  return accepted(nextState, { kind: 'accepted', reason: 'source-generation-advanced' });
}

function reduceMapReset(state: RuntimeState, input: MapResetInput): RuntimeReduceResult {
  assertRuntimeTime(input.at);
  if (state.map.epoch === 0) {
    return ignored(state, 'map-not-established');
  }

  const nextState: RuntimeState = {
    producerInstanceId: state.producerInstanceId,
    liveSession: state.liveSession,
    runtimeSeq: state.runtimeSeq + 1,
    programSource: state.programSource,
    map: {
      ...state.map,
      epoch: state.map.epoch + 1,
    },
    playerStats: createMapPlayerStatsAccumulator(state.map.epoch + 1),
    objectiveTiming: createObjectiveTimingState(
      state.programSource.generation,
      state.map.epoch + 1,
    ),
  };
  const transition = explicitMapExecutionChangedTransition(
    state,
    nextState,
    input.at,
    input.reason,
  );
  return accepted(nextState, { kind: 'accepted', reason: 'map-execution-reset' }, [transition]);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled RuntimeInput kind: ${String(value)}`);
}

export function reduceRuntime(
  state: RuntimeState,
  input: RuntimeInput,
  policy: RuntimeContinuityPolicy,
): RuntimeReduceResult {
  assertRuntimeContinuityPolicy(policy);
  switch (input.kind) {
    case 'program-telemetry':
      return reduceProgramTelemetry(state, input, policy);
    case 'advance-program-source-generation':
      return reduceGenerationAdvance(state, input);
    case 'reset-map-execution':
      return reduceMapReset(state, input);
  }
  return assertNever(input);
}
