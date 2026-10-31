import type { ProgramProjection } from '@mizar/core/projection';

// These opaque keys are consumer invalidation scopes, not authoritative Runtime IDs.
// A key of one kind cannot be substituted for another merely because both are strings.
declare const scopeKind: unique symbol;
type Scope<Kind extends string> = string & { readonly [scopeKind]: Kind };
export type SceneMatchScope = Scope<'scene-match'>;
export type SceneExecutionScope = Scope<'scene-execution'>;
export type SceneRequestScope = Scope<'scene-request'>;
export type SceneResultScope = Scope<'scene-result'>;
export type MusicMapScope = Scope<'music-map'>;
export type CameraExecutionScope = Scope<'camera-execution'>;
export type CameraControlScope = Scope<'camera-control'>;

function matchParticipants(p: ProgramProjection) {
  return [p.match?.matchId, p.series?.entrants.a.entryId, p.series?.entrants.b.entryId] as const;
}

/** Scene choices follow the selected match and its configured series, not a connection. */
export function sceneMatchScope(p: ProgramProjection): SceneMatchScope {
  return JSON.stringify([
    ...matchParticipants(p),
    p.series?.format,
    p.series?.maps.map((map) => [map.mapOrder, map.mapName]),
  ]) as SceneMatchScope;
}

/** Execution adds producer/session and map epoch; source generation only invalidates requests. */
export function sceneExecutionScope(p: ProgramProjection): SceneExecutionScope {
  return `${sceneMatchScope(p)}:${p.cursor.producerInstanceId}:${p.cursor.liveSessionId}:${p.cursor.mapEpoch}:${p.series?.currentMapOrder}` as SceneExecutionScope;
}
export function sceneRequestScope(p: ProgramProjection): SceneRequestScope {
  return `${sceneExecutionScope(p)}:${p.cursor.programSourceGeneration}` as SceneRequestScope;
}
export function sceneResultScope(p: ProgramProjection): SceneResultScope {
  return `${sceneMatchScope(p)}:${p.cursor.liveSessionId}:${p.cursor.mapEpoch}` as SceneResultScope;
}

/** Music cues intentionally survive producer and connection changes within the same map. */
export function musicMapScope(p: ProgramProjection): MusicMapScope {
  return JSON.stringify([
    ...matchParticipants(p),
    p.series?.currentMapOrder,
    p.map.name,
    p.cursor.mapEpoch,
  ]) as MusicMapScope;
}

/** Camera execution adds producer/session to the music map; reconnecting the provider is separate. */
export function cameraExecutionScope(p: ProgramProjection): CameraExecutionScope {
  return JSON.stringify([
    musicMapScope(p),
    p.cursor.producerInstanceId,
    p.cursor.liveSessionId,
  ]) as CameraExecutionScope;
}
/** Source generation, configuration revision and local control epoch invalidate pending control.
 * This scope is not a device connection or a grant of authority. */
export function cameraControlScope(
  p: ProgramProjection,
  revision: number,
  controlEpoch: number,
): CameraControlScope {
  return JSON.stringify([
    cameraExecutionScope(p),
    p.cursor.programSourceGeneration,
    revision,
    controlEpoch,
  ]) as CameraControlScope;
}
