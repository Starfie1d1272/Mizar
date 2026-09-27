import type { ProjectionCursor } from '@mizar/protocol/shared';

function boundary(cursor: ProjectionCursor): string {
  return [
    cursor.producerInstanceId,
    cursor.liveSessionId ?? 'unbound',
    cursor.programSourceGeneration,
    cursor.mapEpoch,
  ].join(':');
}

export function consecutivePresentationSamples(
  previous: ProjectionCursor | null,
  current: ProjectionCursor,
  previousRevision = 0,
  currentRevision = previousRevision,
): boolean {
  if (previousRevision !== currentRevision) return false;
  if (previous === null || boundary(previous) !== boundary(current)) return false;
  const previousSequence = previous.programReceiveSequence ?? previous.runtimeSeq;
  const currentSequence = current.programReceiveSequence ?? current.runtimeSeq;
  return currentSequence === previousSequence + 1;
}
