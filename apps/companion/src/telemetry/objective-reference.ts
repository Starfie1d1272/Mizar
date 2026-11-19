import type { CaptureRecorder } from './capture-recorder.js';
import type { CstvSourceManager } from './cstv-source-manager.js';

export interface ObjectiveReferenceSource {
  readonly artifactId: string;
  readonly artifactSha256: string;
}

export function subscribeObjectiveReference(
  source: Pick<CstvSourceManager<'program'>, 'subscribeLiveGameEvents'>,
  currentRecorder: () => CaptureRecorder,
  objectiveReferenceSource: ObjectiveReferenceSource | undefined,
): (() => void) | undefined {
  return objectiveReferenceSource === undefined ||
    currentRecorder().tryRecordObjectiveReference === undefined
    ? undefined
    : source.subscribeLiveGameEvents((observation) => {
        if (!(
          observation.kind === 'bomb-begin-plant' ||
          observation.kind === 'bomb-abort-plant' ||
          observation.kind === 'bomb-planted' ||
          observation.kind === 'bomb-begin-defuse' ||
          observation.kind === 'bomb-abort-defuse' ||
          observation.kind === 'bomb-defused' ||
          observation.kind === 'bomb-exploded'
        ))
          return;
        const objective = observation;
        const mapName = objective.cursor.mapName;
        const ticksPerSecond = objective.cursor.ticksPerSecond;
        if (
          typeof mapName !== 'string' ||
          mapName.trim().length === 0 ||
          typeof ticksPerSecond !== 'number' ||
          !Number.isFinite(ticksPerSecond) ||
          ticksPerSecond <= 0
        )
          return;
        const referenceId = `cstv-${objective.cursor.role}-${objective.cursor.generation}-${objective.cursor.sequence}-${objective.kind}`;
        currentRecorder().tryRecordObjectiveReference?.({
          referenceId,
          kind: objective.kind,
          source: 'cstv',
          occurredMonotonicMs: objective.cursor.observedMonotonicMs,
          sourceCursor: {
            ...objective.cursor,
            mapName,
            ticksPerSecond,
          },
          sourceArtifact: {
            id: objectiveReferenceSource.artifactId,
            sha256: objectiveReferenceSource.artifactSha256,
          },
          ...(objective.kind === 'bomb-begin-defuse' ? { hasKit: objective.hasKit } : {}),
        });
      });
}
