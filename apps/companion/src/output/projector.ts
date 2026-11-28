import { createHash } from 'node:crypto';

import { projectPublicRadarFrame } from '@mizar/radar';

import { completedSeriesMapForProgram } from '@mizar/core/projection';
import {
  parseLiveSnapshotV1,
  publicRadarV1Schema,
  parseReliableEventV2,
  type LiveSnapshotV1,
  type ReliableEventKindV2,
  type ReliableEventV2,
} from '@mizar/protocol/output';

import type { MatchContextBinding } from '../match-context/index.js';
import { hasLineupMismatchOnly } from './lineup-mismatch.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';

type LiveProjectionInput = Pick<ProjectionBundle, 'program' | 'radar' | 'operator' | 'identity'>;

export type LiveSnapshotBlockedReason =
  | 'binding_missing'
  | 'binding_stale'
  | 'competition_missing'
  | 'snapshot_match_mismatch'
  | 'telemetry_unavailable'
  | 'telemetry_stale'
  | 'identity_mismatch'
  | 'context_stale';

/** The same eligibility decision used by publication and its private explanation. */
export function liveSnapshotBlockedReason(
  bundle: LiveProjectionInput,
  binding: MatchContextBinding | undefined,
): LiveSnapshotBlockedReason | null {
  if (!binding) return 'binding_missing';
  if (binding.freshness !== 'fresh') return 'binding_stale';
  if (binding.context.competition === null) return 'competition_missing';
  if (bundle.program.match?.matchId !== binding.context.matchId) return 'snapshot_match_mismatch';
  if (bundle.program.status.telemetry !== 'fresh')
    return bundle.program.status.telemetry === 'stale'
      ? 'telemetry_stale'
      : 'telemetry_unavailable';
  if (bundle.program.status.identity === 'mismatch') return 'identity_mismatch';
  if (bundle.program.status.context !== 'fresh') return 'context_stale';
  return null;
}

export interface ReliableMapResult {
  readonly mapId: string | null;
  readonly mapName: string;
  readonly scoreA: number;
  readonly scoreB: number;
}

export interface MapRosterSnapshot {
  readonly lineupSteam64: string[];
  readonly players: NonNullable<
    Extract<ReliableEventV2, { kind: 'map_ended' }>['payload']['players']
  >;
  readonly scoreCT?: number;
  readonly scoreT?: number;
}

function entrantRelativeMapResult(bundle: ProjectionBundle): ReliableMapResult | null {
  const resultMap = completedSeriesMapForProgram(bundle.program);
  if (!resultMap?.finalScore) return null;
  return {
    mapId: resultMap.mapId,
    mapName: resultMap.mapName,
    scoreA: resultMap.finalScore.a,
    scoreB: resultMap.finalScore.b,
  };
}

export function projectLiveSnapshotV1(input: {
  readonly bundle: LiveProjectionInput;
  readonly binding: MatchContextBinding | undefined;
  readonly producedAt: string;
  readonly includeRadar?: boolean;
}): LiveSnapshotV1 | null {
  const { bundle, binding } = input;
  if (
    liveSnapshotBlockedReason(bundle, binding) ||
    binding === undefined ||
    binding.context.competition === null
  )
    return null;
  const { program, radar, operator } = bundle;
  const lineupMismatchOnly = hasLineupMismatchOnly(bundle, binding);
  const currentMap = program.series?.maps.find(
    (map) => map.mapOrder === program.series?.currentMapOrder,
  );
  const radarAligned =
    radar.cursor.producerInstanceId === program.cursor.producerInstanceId &&
    radar.cursor.liveSessionId === program.cursor.liveSessionId &&
    radar.mapName === program.map.name &&
    radar.telemetryFreshness === 'fresh' &&
    radar.identityState !== 'mismatch' &&
    radar.cursor.programSourceGeneration === program.cursor.programSourceGeneration &&
    radar.cursor.mapEpoch === program.cursor.mapEpoch &&
    radar.cursor.programReceiveSequence === program.cursor.programReceiveSequence;
  const projectedRadar = radarAligned
    ? projectPublicRadarFrame({
        ...radar,
        players: radar.players.map((player) => ({
          ...player,
          canonicalPlayerId:
            program.players.find(
              (candidate) =>
                candidate.sourcePlayerId === player.sourcePlayerId &&
                candidate.identityEvidence === 'canonical',
            )?.canonicalPlayerId ?? null,
        })),
      })
    : null;
  const parsedRadar = publicRadarV1Schema.safeParse(projectedRadar);
  const publicRadar = parsedRadar.success ? parsedRadar.data : null;
  const radarCurrent = publicRadar !== null;
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
    roundHistory: program.series?.roundHistory ?? null,
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
        identityEvidence:
          lineupMismatchOnly && player.canonicalPlayerId === null
            ? 'observed'
            : player.identityEvidence,
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
    radar: input.includeRadar === true ? publicRadar : null,
    capability: {
      telemetryFresh: true,
      contextFresh: true,
      identity: program.status.identity,
      lineupComplete: operator.activeLineup.ctCount === 5 && operator.activeLineup.tCount === 5,
      radarCurrent,
      canonicalTeams: program.teams.ct.mode === 'canonical' && program.teams.t.mode === 'canonical',
      ...(lineupMismatchOnly ? { lineupMismatchOnly: true } : {}),
    },
  };
  return parseLiveSnapshotV1(snapshot);
}

export function extractMapRosterSnapshot(bundle: ProjectionBundle): MapRosterSnapshot {
  const lineupSteam64 = bundle.program.players
    .filter(
      (player) => player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
    )
    .slice(0, 10)
    .map((player) => player.sourcePlayerId);
  const players = bundle.program.players
    .filter((player) => player.lineupEvidence === 'current')
    .slice(0, 10)
    .map((player) => ({
      sourcePlayerId: player.sourcePlayerId,
      canonicalPlayerId: player.canonicalPlayerId,
      kills: player.matchStats?.kills ?? null,
      assists: player.matchStats?.assists ?? null,
      deaths: player.matchStats?.deaths ?? null,
    }));
  return {
    lineupSteam64,
    players,
    ...(bundle.program.map.score.ct !== null && bundle.program.map.score.t !== null
      ? { scoreCT: bundle.program.map.score.ct, scoreT: bundle.program.map.score.t }
      : {}),
  };
}

export function buildReliableEventV2(input: {
  readonly kind: ReliableEventKindV2;
  readonly bundle: ProjectionBundle;
  readonly binding: MatchContextBinding | undefined;
  readonly observedAt: string;
  readonly authorityRevision: number;
  readonly completedMap?: ReliableMapResult;
  readonly roster?: MapRosterSnapshot;
}): ReliableEventV2 | null {
  const { binding, bundle } = input;
  if (
    binding === undefined ||
    binding.origin !== 'online' ||
    binding.context.competition === null ||
    bundle.program.match?.matchId !== binding.context.matchId ||
    bundle.program.status.identity === 'mismatch'
  )
    return null;

  if (
    input.kind !== 'map_ended' &&
    (binding.freshness !== 'fresh' ||
      bundle.program.status.context !== 'fresh' ||
      bundle.program.status.telemetry !== 'fresh')
  )
    return null;

  const cursor = bundle.program.cursor;
  if (cursor.liveSessionId === null) return null;

  const currentMap = bundle.program.series?.maps.find(
    (item) => item.mapOrder === bundle.program.series?.currentMapOrder,
  );
  const displayOnly = hasLineupMismatchOnly(bundle, binding);
  const observedEnd =
    displayOnly &&
    input.kind === 'map_ended' &&
    currentMap &&
    bundle.program.map.phase === 'gameover' &&
    bundle.program.map.score.ct !== null &&
    bundle.program.map.score.t !== null
      ? {
          mapId: currentMap.mapId,
          mapName: currentMap.mapName,
          scoreA:
            bundle.operator.identity.sideMapping.a === 'CT'
              ? bundle.program.map.score.ct
              : bundle.program.map.score.t,
          scoreB:
            bundle.operator.identity.sideMapping.b === 'CT'
              ? bundle.program.map.score.ct
              : bundle.program.map.score.t,
        }
      : null;
  const mapResult =
    input.kind === 'map_ended'
      ? (input.completedMap ?? observedEnd ?? entrantRelativeMapResult(bundle))
      : null;
  if (input.kind === 'map_ended' && mapResult === null) return null;

  const mapId = mapResult?.mapId ?? currentMap?.mapId ?? null;
  const mapName = mapResult?.mapName ?? bundle.program.map.name;
  const roster = input.roster ?? extractMapRosterSnapshot(bundle);
  const lineupSteam64 = roster.lineupSteam64;

  let payloadCore: Record<string, unknown>;
  let payload: ReliableEventV2['payload'];
  switch (input.kind) {
    case 'match_started':
      payloadCore = {};
      payload = lineupSteam64.length ? { lineupSteam64 } : {};
      break;
    case 'map_started':
      payloadCore = {};
      payload = lineupSteam64.length ? { lineupSteam64 } : {};
      break;
    case 'map_ended': {
      const sameCurrentMap = bundle.program.map.name === mapResult!.mapName;
      const scoreCT =
        (sameCurrentMap && bundle.program.map.score.ct !== null
          ? bundle.program.map.score.ct
          : undefined) ??
        roster.scoreCT ??
        (bundle.operator.identity.sideMapping.a === 'CT' ? mapResult!.scoreA : mapResult!.scoreB);
      const scoreT =
        (sameCurrentMap && bundle.program.map.score.t !== null
          ? bundle.program.map.score.t
          : undefined) ??
        roster.scoreT ??
        (bundle.operator.identity.sideMapping.a === 'CT' ? mapResult!.scoreB : mapResult!.scoreA);
      const players = roster.players;
      payloadCore = {
        scoreA: mapResult!.scoreA,
        scoreB: mapResult!.scoreB,
        scoreCT,
        scoreT,
      };
      payload = {
        scoreA: mapResult!.scoreA,
        scoreB: mapResult!.scoreB,
        scoreCT,
        scoreT,
        lineupSteam64,
        ...(players.length ? { players } : {}),
      };
      break;
    }
  }

  const idempotencyKey = createHash('sha256')
    .update(
      JSON.stringify({
        kind: input.kind,
        matchId: binding.context.matchId,
        producerInstanceId: cursor.producerInstanceId,
        liveSessionId: cursor.liveSessionId,
        mapId,
        mapName,
        payloadCore,
      }),
    )
    .digest('hex');

  return parseReliableEventV2({
    schemaVersion: 'mizar.reliable-event.v2',
    idempotencyKey,
    kind: input.kind,
    observedAt: input.observedAt,
    matchId: binding.context.matchId,
    competitionId: binding.context.competition.competitionId,
    entryAId: binding.context.entrants.a.entryId,
    entryBId: binding.context.entrants.b.entryId,
    mapId,
    mapName,
    session: {
      producerInstanceId: cursor.producerInstanceId,
      liveSessionId: cursor.liveSessionId,
      authorityRevision: input.authorityRevision,
    },
    payload,
  });
}
