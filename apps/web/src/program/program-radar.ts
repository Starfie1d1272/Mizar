import type { ProgramSnapshot } from '@mizar/protocol/program';
import type { RadarSnapshot } from '@mizar/protocol/radar';

export function radarMatchesProgram(
  program: ProgramSnapshot | null,
  radar: RadarSnapshot | null,
): boolean {
  if (program?.payload.status.telemetry !== 'fresh' || radar === null) return false;
  const a = program.cursor;
  const b = radar.cursor;
  return (
    a.producerInstanceId === b.producerInstanceId &&
    a.liveSessionId === b.liveSessionId &&
    a.programSourceGeneration === b.programSourceGeneration &&
    a.mapEpoch === b.mapEpoch
  );
}
