import { createHash } from 'node:crypto';

import type { RuntimeReduceResult } from '@mizar/core/runtime';
import {
  parseLiveSnapshotV1,
  parseReliableEventV1,
  type LiveSnapshotV1,
  type ReliableEventKindV1,
  type ReliableEventV1,
} from '@mizar/protocol/output';

import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';

function eligible(bundle: ProjectionBundle, binding: MatchContextBinding | undefined): boolean {
  return (
    binding !== undefined &&
    binding.freshness === 'fresh' &&
    bundle.program.match?.matchId === binding.context.matchId &&
    bundle.program.status.telemetry === 'fresh' &&
    bundle.program.status.identity !== 'mismatch' &&
    bundle.program.status.context === 'fresh'
  );
}

interface ReliableMapResult {
  readonly mapId: string;
  readonly mapName: string;
  readonly scoreA: number;
  readonly scoreB: number;
}

function entrantRelativeMapResult(
  bundle: ProjectionBundle,
  binding: MatchContextBinding,
  cursor: ProjectionBundle['program']['cursor'],
): ReliableMapResult | null {
  const progressMap = bundle.operator.seriesProgress?.maps.find(
    (map) => map.executionMapEpoch === cursor.mapEpoch,
  );
  if (
    progressMap === undefined ||
    progressMap.status !== 'completed' ||
    progressMap.finalScore === null
  )
    return null;
  const contextMap = binding.context.maps.find((map) => map.mapOrder === progressMap.mapOrder);
  if (contextMap === undefined) return null;
  return {
    mapId: contextMap.mapId,
    mapName: progressMap.mapName,
    scoreA: progressMap.finalScore.a,
    scoreB: progressMap.finalScore.b,
  };
}

export function projectLiveSnapshotV1(input: {
  readonly bundle: ProjectionBundle;
  readonly binding: MatchContextBinding | undefined;
  readonly producedAt: string;
  readonly includeRadar?: boolean;
}): LiveSnapshotV1 | null {
  const { bundle, binding } = input;
  if (!eligible(bundle, binding) || binding === undefined) return null;
  const { program, radar, operator } = bundle;
  const currentMap = program.series?.maps.find(
    (map) => map.mapOrder === program.series?.currentMapOrder,
  );
  const radarCurrent =
    radar.telemetryFreshness === 'fresh' &&
    radar.identityState !== 'mismatch' &&
    radar.cursor.programSourceGeneration === program.cursor.programSourceGeneration &&
    radar.cursor.mapEpoch === program.cursor.mapEpoch &&
    radar.cursor.programReceiveSequence === program.cursor.programReceiveSequence;
  const includeRadar = input.includeRadar === true && radarCurrent;
  const team = (value: typeof program.teams.ct) => ({
    entryId: value.entryId,
    name: value.name,
  });
  const snapshot = {
    schemaVersion: 'mizar.live-snapshot.v1',
    cursor: program.cursor,
    producedAt: input.producedAt,
    matchId: binding.context.matchId,
    competitionId: binding.context.competition.competitionId,
    format: binding.context.format,
    series: {
      scoreA: program.series?.score.a ?? null,
      scoreB: program.series?.score.b ?? null,
      currentMapOrder: program.series?.currentMapOrder ?? null,
    },
    map: {
      mapId: currentMap?.mapId ?? null,
      name: program.map.name,
      phase: program.map.phase,
      roundNumber: program.map.roundNumber,
      scoreCT: program.map.score.ct,
      scoreT: program.map.score.t,
    },
    roundPhase: program.round?.phase ?? null,
    clock:
      program.clock === null
        ? null
        : {
            phase: program.clock.phase,
            remainingSeconds: program.clock.endsInSeconds,
          },
    teams: { ct: team(program.teams.ct), t: team(program.teams.t) },
    players: program.players.map((player) => {
      const active = player.weapons.filter(
        (weapon) => weapon.state === 'active' || weapon.state === 'reloading',
      );
      const weapon = active.length === 1 ? active[0] : undefined;
      return {
        sourcePlayerId: player.sourcePlayerId,
        canonicalPlayerId: player.canonicalPlayerId,
        identityEvidence: player.identityEvidence,
        lineupEvidence: player.lineupEvidence,
        displayName: player.displayName,
        side: player.side,
        lifeState: player.lifeState,
        health: player.state?.health ?? null,
        armor: player.state?.armor ?? null,
        hasHelmet: player.state?.hasHelmet ?? null,
        hasDefuser: player.state?.hasDefuser ?? null,
        money: player.state?.money ?? null,
        equipmentValue: player.state?.equipValue ?? null,
        activeWeapon:
          weapon === undefined
            ? null
            : {
                name: weapon.name,
                ammoClip: weapon.ammoClip,
                ammoReserve: weapon.ammoReserve,
              },
        stats: {
          kills: player.matchStats?.kills ?? null,
          assists: player.matchStats?.assists ?? null,
          deaths: player.matchStats?.deaths ?? null,
          liveAdr: player.liveAdr,
          completedAdr: player.completedAdr,
        },
      };
    }),
    observedPlayerSourceId: program.observedPlayerSourceId,
    bomb:
      program.bomb === null
        ? null
        : {
            state: program.bomb.state,
            carrierSourceId: program.bomb.sourcePlayerId,
            action:
              program.bomb.action === null
                ? null
                : {
                    kind: program.bomb.action.kind,
                    sourcePlayerId: program.bomb.action.sourcePlayerId,
                    remainingSeconds: program.bomb.action.remainingSeconds,
                    durationSeconds: program.bomb.action.durationSeconds,
                  },
          },
    radar: !includeRadar
      ? null
      : {
          players: radar.players.map((player) => ({
            sourcePlayerId: player.sourcePlayerId,
            position: player.position,
            forward: player.forward,
          })),
          bombPosition: radar.bomb?.position ?? null,
          utility: radar.grenades.map((grenade) => ({
            sourceEntityId: grenade.sourceEntityId,
            kind: grenade.kind,
            ownerSourceId: grenade.ownerSourceId,
            position: grenade.position,
            flames: grenade.flames.map((flame) => ({
              sourceFlameId: flame.sourceFlameId,
              position: flame.position,
            })),
          })),
        },
    capability: {
      telemetryFresh: true,
      contextFresh: true,
      identity: program.status.identity,
      lineupComplete: operator.activeLineup.ctCount === 5 && operator.activeLineup.tCount === 5,
      radarCurrent,
      canonicalTeams: program.teams.ct.mode === 'canonical' && program.teams.t.mode === 'canonical',
    },
  };
  return parseLiveSnapshotV1(snapshot);
}

export function buildReliableEventV1(input: {
  readonly kind: ReliableEventKindV1;
  readonly bundle: ProjectionBundle;
  readonly binding: MatchContextBinding | undefined;
  readonly observedAt: string;
  readonly source: ReliableEventV1['evidence']['source'];
  readonly reason?: string | null;
  readonly previousMapEpoch?: number | null;
  readonly previousSourceGeneration?: number | null;
  readonly cursor?: ProjectionBundle['program']['cursor'];
}): ReliableEventV1 | null {
  const { binding, bundle } = input;
  if (
    binding === undefined ||
    binding.freshness !== 'fresh' ||
    bundle.program.match?.matchId !== binding.context.matchId ||
    bundle.program.status.context !== 'fresh'
  )
    return null;
  const warning =
    input.kind === 'identity_mismatch' ||
    input.kind === 'lineup_mismatch' ||
    input.kind === 'source_generation_changed' ||
    input.kind === 'map_epoch_changed';
  if (
    !warning &&
    (bundle.program.status.telemetry !== 'fresh' || bundle.program.status.identity === 'mismatch')
  )
    return null;
  const cursor = input.cursor ?? bundle.program.cursor;
  const currentMap = bundle.program.series?.maps.find(
    (item) => item.mapOrder === bundle.program.series?.currentMapOrder,
  );
  const mapResult =
    input.kind === 'map_ended' ? entrantRelativeMapResult(bundle, binding, cursor) : null;
  if (
    input.kind === 'map_ended' &&
    (mapResult === null || bundle.program.map.score.ct === null || bundle.program.map.score.t === null)
  )
    return null;
  const payload = (() => {
    switch (input.kind) {
      case 'match_started':
      case 'map_started':
        return {};
      case 'map_ended':
        return {
          scoreA: mapResult!.scoreA,
          scoreB: mapResult!.scoreB,
          scoreCT: bundle.program.map.score.ct!,
          scoreT: bundle.program.map.score.t!,
        };
      case 'series_ended':
        return {
          scoreA: bundle.program.series?.score.a ?? null,
          scoreB: bundle.program.series?.score.b ?? null,
        };
      case 'source_generation_changed':
        return { previousSourceGeneration: input.previousSourceGeneration ?? null };
      case 'map_epoch_changed':
        return { previousMapEpoch: input.previousMapEpoch ?? null, reason: input.reason ?? null };
      case 'identity_mismatch':
      case 'lineup_mismatch':
        return { reason: input.reason ?? null };
    }
  })();
  const identity = {
    kind: input.kind,
    producerInstanceId: cursor.producerInstanceId,
    liveSessionId: cursor.liveSessionId,
    matchId: binding.context.matchId,
    contextRevision: binding.manifest.revision,
    mapEpoch: cursor.mapEpoch,
    sourceGeneration: cursor.programSourceGeneration,
    runtimeSeq: cursor.runtimeSeq,
    payload,
  };
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return parseReliableEventV1({
    schemaVersion: 'mizar.reliable-event.v1',
    idempotencyKey: hash,
    kind: input.kind,
    cursor,
    observedAt: input.observedAt,
    matchId: binding.context.matchId,
    competitionId: binding.context.competition.competitionId,
    contextRevision: binding.manifest.revision,
    mapId: mapResult?.mapId ?? currentMap?.mapId ?? null,
    mapName: mapResult?.mapName ?? bundle.program.map.name,
    entryAId: binding.context.entrants.a.entryId,
    entryBId: binding.context.entrants.b.entryId,
    evidence: {
      identity: bundle.program.status.identity,
      telemetryFresh: bundle.program.status.telemetry === 'fresh',
      contextFresh: true,
      source: input.source,
    },
    payload,
  });
}

export function transitionReliableEventsV1(input: {
  readonly result: RuntimeReduceResult;
  readonly bundle: ProjectionBundle;
  readonly binding: MatchContextBinding | undefined;
}): readonly ReliableEventV1[] {
  if (input.result.disposition.kind !== 'accepted') return [];
  const events: ReliableEventV1[] = [];
  const add = (candidate: ReliableEventV1 | null) => {
    if (candidate !== null) events.push(candidate);
  };
  for (const transition of input.result.transitions) {
    if (transition.kind === 'map_ended')
      add(
        buildReliableEventV1({
          kind: 'map_ended',
          bundle: input.bundle,
          binding: input.binding,
          observedAt: transition.at.utc,
          source: 'runtime-transition',
        }),
      );
    if (transition.kind === 'map_execution_changed')
      add(
        buildReliableEventV1({
          kind: 'map_epoch_changed',
          bundle: input.bundle,
          binding: input.binding,
          observedAt: transition.at.utc,
          source: 'runtime-transition',
          previousMapEpoch: transition.previousMapEpoch,
          reason: transition.reason,
        }),
      );
  }
  return events;
}
