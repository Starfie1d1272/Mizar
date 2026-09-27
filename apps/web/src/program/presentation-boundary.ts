import type { ProgramSnapshot } from '@mizar/protocol/program';

import type { LocalChannelConnectionState } from '../realtime';

export function hasAcceptedProgramSnapshot(
  snapshot: ProgramSnapshot | null | undefined,
  connectionState: LocalChannelConnectionState | undefined,
): snapshot is ProgramSnapshot {
  return (
    snapshot !== null &&
    snapshot !== undefined &&
    snapshot.payload.status.telemetry === 'fresh' &&
    (connectionState === undefined || connectionState === 'live')
  );
}

/**
 * Stable presentation identity shared by Program and Current Live preview.
 * Reset signals are already represented by the accepted cursor; adding them
 * separately would cause a second remount on the frame after a reset.
 */
export function presentationBoundaryKey(
  snapshot: ProgramSnapshot | null | undefined,
  connectionState: LocalChannelConnectionState | undefined,
): string {
  if (!hasAcceptedProgramSnapshot(snapshot, connectionState)) return 'fail-closed';
  const cursor = snapshot.cursor;
  return [
    'accepted',
    cursor.producerInstanceId,
    cursor.liveSessionId ?? 'unbound',
    cursor.programSourceGeneration,
    cursor.mapEpoch,
  ].join(':');
}
