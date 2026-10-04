import {
  createStandingC4Predictor,
  STATIC_MODEL_REVISION,
  type BombDamageField,
} from 'cs2-c4-damage';
import type { ProgramProjectionInput } from './program.js';
import { getProgramSafeRuntimeFreshness } from './program-safe-runtime.js';

export interface PreparedBombDamage {
  readonly mapName: string;
  readonly modelRevision: string;
  readonly resourceSha256: string;
  readonly predict: ReturnType<typeof createStandingC4Predictor>;
}
export type BombDamageResource =
  | { readonly status: 'ready'; readonly value: PreparedBombDamage }
  | { readonly status: 'unavailable'; readonly reason: string };
export type BombDamagePlayer = { readonly sourcePlayerId: string } & (
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'predicted';
      readonly stance: 'standing';
      readonly damage: number;
      readonly hpAfter: number;
      readonly lethal: boolean;
      readonly modelRevision: string;
      readonly assumptions: readonly string[];
      readonly unknownInputs: readonly string[];
    }
);
export interface BombDamageProjection {
  readonly status: 'available' | 'unavailable';
  readonly reason: string | null;
  readonly model: {
    readonly packageVersion: '0.1.0';
    readonly mapName: string;
    readonly modelRevision: string;
    readonly resourceSha256: string;
  } | null;
  readonly players: readonly BombDamagePlayer[];
}
export function prepareBombDamage(field: BombDamageField): PreparedBombDamage {
  if (
    field.metadata.modelRevision !== STATIC_MODEL_REVISION ||
    !field.metadata.normalizedFieldSha256
  )
    throw new Error('model-resource-mismatch');
  return {
    mapName: field.metadata.mapName,
    modelRevision: field.metadata.modelRevision,
    resourceSha256: field.metadata.normalizedFieldSha256,
    predict: createStandingC4Predictor(field),
  };
}
export function projectBombDamage(input: ProgramProjectionInput): BombDamageProjection {
  const unavailable = (reason: string): BombDamageProjection => ({
    status: 'unavailable',
    reason,
    model: null,
    players: [],
  });
  const { runtime, activeLineup } = input;
  const observation = runtime.telemetry;
  if (
    getProgramSafeRuntimeFreshness(runtime, input.nowMonotonicMs, input.continuityPolicy) !==
    'fresh'
  )
    return unavailable('stale');
  const telemetry = observation?.telemetry;
  if (
    observation?.coverage.bomb !== 'present' ||
    observation.coverage.map !== 'present' ||
    observation.coverage.round !== 'present' ||
    observation.coverage.allPlayers !== 'present'
  )
    return unavailable('coverage');
  if (
    telemetry?.round?.phase !== 'live' ||
    !['planted', 'defusing'].includes(telemetry.bomb?.state ?? '')
  )
    return unavailable('inactive');
  if (
    runtime.objectiveTiming.sourceGeneration !== runtime.cursor.programSourceGeneration ||
    runtime.objectiveTiming.mapEpoch !== runtime.cursor.mapEpoch ||
    runtime.objectiveTiming.lastAcceptedReceiveSequence !== runtime.cursor.programReceiveSequence ||
    activeLineup.sourceGeneration !== runtime.cursor.programSourceGeneration ||
    activeLineup.mapEpoch !== runtime.cursor.mapEpoch ||
    activeLineup.state !== 'complete' ||
    input.identity.state === 'mismatch'
  )
    return unavailable('context');
  const resource = input.bombDamageResource;
  if (!resource || resource.status === 'unavailable')
    return unavailable(resource?.reason ?? 'resource-not-ready');
  const prepared = resource.value;
  if (prepared.mapName !== telemetry.map?.name) return unavailable('map-mismatch');
  const bombPosition = telemetry.bomb?.position;
  if (!bombPosition) return unavailable('bomb-position');
  const players = [...activeLineup.ct, ...activeLineup.t]
    .slice(0, 10)
    .map((entry): BombDamagePlayer => {
      const player = entry.observed;
      const health = player?.state?.health;
      if (
        entry.lineupEvidence !== 'current' ||
        !player ||
        health === undefined ||
        health <= 0 ||
        !player.position ||
        !player.forward
      )
        return {
          sourcePlayerId: entry.sourcePlayerId,
          status: 'unavailable',
          reason: 'player-input',
        };
      try {
        const result = prepared.predict({
          bombPosition,
          playerPosition: player.position,
          playerForward: player.forward,
          health,
        });
        return { sourcePlayerId: entry.sourcePlayerId, ...result };
      } catch {
        return {
          sourcePlayerId: entry.sourcePlayerId,
          status: 'unavailable',
          reason: 'model-unavailable',
        };
      }
    });
  return {
    status: 'available',
    reason: null,
    model: {
      packageVersion: '0.1.0',
      mapName: prepared.mapName,
      modelRevision: prepared.modelRevision,
      resourceSha256: prepared.resourceSha256,
    },
    players,
  };
}
