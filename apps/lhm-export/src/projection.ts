import {
  emptyActiveLineup,
  resolveActiveLineup,
  unboundIdentityResolution,
} from '@mizar/core/identity';
import { projectProgram, selectProgramSafeRuntimeView } from '@mizar/core/projection';
import { createInitialRuntimeState, reduceRuntime } from '@mizar/core/runtime';
import { adaptGsiPayload } from '@mizar/telemetry-gsi';
import { projectRadarFrame } from '@mizar/radar';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { radarSnapshotSchema } from '@mizar/protocol/radar';
import {
  LOCAL_PROTOCOL_VERSION,
  PROGRAM_SCHEMA_VERSION,
  RADAR_SCHEMA_VERSION,
} from '@mizar/protocol/version';

/** Turn the host's current GSI into the same pure projection used by Mizar. */
export function createLhmProjection() {
  const policy = { staleAfterMs: 20_000 };
  let runtime = createInitialRuntimeState('lhm-export');
  let lineup = emptyActiveLineup(0, 0);
  let sequence = 0;
  const refresh = (now = performance.now()) => {
    if (!runtime.programTelemetry) return null;
    const view = selectProgramSafeRuntimeView(runtime);
    const identity = unboundIdentityResolution();
    const projection = projectProgram({
      runtime: view,
      identity,
      activeLineup: lineup,
      continuityPolicy: policy,
      nowMonotonicMs: now,
      presentationRole: 'gameplay',
    });
    const radar = projectRadarFrame({
      runtime: view,
      identity,
      continuityPolicy: policy,
      nowMonotonicMs: now,
    });
    const radarPayload = {
      telemetryFreshness: radar.telemetryFreshness,
      identityState: radar.identityState,
      mapName: radar.mapName,
      observedPlayerSourceId: radar.observedPlayerSourceId,
      coverage: radar.coverage,
      players: radar.players,
      bomb: radar.bomb,
      grenades: radar.grenades,
    };
    return {
      program: programSnapshotSchema.parse({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        schemaVersion: PROGRAM_SCHEMA_VERSION,
        channel: 'program',
        channelSeq: sequence,
        cursor: view.cursor,
        payload: projection,
      }),
      radar: radarSnapshotSchema.parse({
        type: 'snapshot',
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        schemaVersion: RADAR_SCHEMA_VERSION,
        channel: 'radar',
        channelSeq: sequence,
        cursor: view.cursor,
        payload: radarPayload,
      }),
    };
  };
  const accept = (raw: unknown, now = performance.now()) => {
    const result = adaptGsiPayload(raw, {
      sequence: ++sequence,
      receivedAt: new Date().toISOString(),
      receivedMonotonicMs: now,
    });
    if (!result.ok) return null;
    const reduced = reduceRuntime(
      runtime,
      {
        kind: 'program-telemetry',
        sourceGeneration: runtime.programSource.generation,
        observation: result.observation,
      },
      policy,
    );
    if (reduced.disposition.kind !== 'accepted') return null;
    runtime = reduced.state;
    const view = selectProgramSafeRuntimeView(runtime);
    const identity = unboundIdentityResolution();
    lineup = resolveActiveLineup({
      sourceGeneration: runtime.programSource.generation,
      mapEpoch: runtime.map.epoch,
      ...(view.telemetry?.telemetry.allPlayers
        ? { allPlayers: view.telemetry.telemetry.allPlayers }
        : {}),
      ...(view.telemetry ? { allPlayersCoverage: view.telemetry.coverage.allPlayers } : {}),
      identity,
      previous: lineup,
    });
    return refresh(now);
  };
  return Object.assign(accept, { refresh });
}
