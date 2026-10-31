import type { ProgramProjection } from '@mizar/core/projection';

function matchParticipants(p: ProgramProjection) {
  return [p.match?.matchId, p.series?.entrants.a.entryId, p.series?.entrants.b.entryId] as const;
}

/** Scene choices follow the selected match and its configured series, not a connection. */
export function sceneMatchScope(p: ProgramProjection): string {
  return JSON.stringify([
    ...matchParticipants(p),
    p.series?.format,
    p.series?.maps.map((map) => [map.mapOrder, map.mapName]),
  ]);
}

/** Scene execution and in-flight requests have distinct invalidation boundaries. */
export function sceneExecutionScope(p: ProgramProjection): string {
  return `${sceneMatchScope(p)}:${p.cursor.producerInstanceId}:${p.cursor.liveSessionId}:${p.cursor.mapEpoch}:${p.series?.currentMapOrder}`;
}
export function sceneRequestScope(p: ProgramProjection): string {
  return `${sceneExecutionScope(p)}:${p.cursor.programSourceGeneration}`;
}
export function sceneResultScope(p: ProgramProjection): string {
  return `${sceneMatchScope(p)}:${p.cursor.liveSessionId}:${p.cursor.mapEpoch}`;
}

/** Music cues intentionally survive producer and connection changes within the same map. */
export function musicMapScope(p: ProgramProjection): string {
  return JSON.stringify([
    ...matchParticipants(p),
    p.series?.currentMapOrder,
    p.map.name,
    p.cursor.mapEpoch,
  ]);
}

/** Camera execution and control each reset for their own reasons. */
export function cameraExecutionScope(p: ProgramProjection): string {
  return JSON.stringify([musicMapScope(p), p.cursor.producerInstanceId, p.cursor.liveSessionId]);
}
export function cameraControlScope(
  p: ProgramProjection,
  revision: number,
  controlEpoch: number,
): string {
  return JSON.stringify([
    cameraExecutionScope(p),
    p.cursor.programSourceGeneration,
    revision,
    controlEpoch,
  ]);
}
