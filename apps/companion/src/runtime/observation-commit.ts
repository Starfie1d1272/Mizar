import type { TelemetryObservation } from '@mizar/core/telemetry';
import type { ProgramCommitResult, ProgramRuntime } from './program-runtime.js';

/** Commits one input and publishes it in the same order for live and replay sources. */
export function createObservationCommit(input: {
  runtime: Pick<
    ProgramRuntime,
    | 'getCurrentState'
    | 'getSnapshot'
    | 'advanceProgramSourceGeneration'
    | 'acceptManagedObservation'
    | 'acceptObservation'
    | 'executeOperatorCommand'
  >;
  beforeMutation(): void;
  publish(result: ProgramCommitResult): void;
  sourceMatchesSelection(sourceId: string): boolean;
  onIgnored(
    observation: TelemetryObservation,
    disposition: Extract<ProgramCommitResult['disposition'], { kind: 'ignored' }>,
  ): void;
}) {
  const programRuntime = input.runtime;
  return (
    observation: TelemetryObservation,
    sampleStageBinding?: { mapOrder: number },
    managedSourceId?: string,
    managedOwner?: { matchId: string },
  ): boolean => {
    const source = programRuntime.getCurrentState().programSource;
    const lastAccepted = source.lastAccepted;
    if (
      !managedOwner &&
      lastAccepted !== undefined &&
      observation.receive.receivedMonotonicMs - lastAccepted.receivedMonotonicMs >
        programRuntime.getSnapshot().continuityPolicy.staleAfterMs
    ) {
      input.beforeMutation();
      const changed = programRuntime.advanceProgramSourceGeneration({
        monotonicMs: observation.receive.receivedMonotonicMs,
        utc: observation.receive.receivedAt,
      });
      input.publish(changed);
    }
    input.beforeMutation();
    const accepted =
      managedOwner && managedSourceId
        ? programRuntime.acceptManagedObservation(
            managedOwner.matchId,
            managedSourceId,
            observation,
          )
        : programRuntime.acceptObservation(
            observation,
            Boolean(managedSourceId && !input.sourceMatchesSelection(managedSourceId)),
          );
    let result = accepted;
    if (result.disposition.kind === 'ignored') input.onIgnored(observation, result.disposition);
    if (sampleStageBinding) {
      const command = programRuntime.executeOperatorCommand({
        kind: 'bind-current-map-execution-to-series-map',
        mapOrder: sampleStageBinding.mapOrder,
        reason: `Rivals 示例第 ${sampleStageBinding.mapOrder} 图执行绑定`,
      });
      result = { ...result, snapshot: command.snapshot };
    }
    input.publish(result);
    return accepted.disposition.kind === 'accepted';
  };
}
