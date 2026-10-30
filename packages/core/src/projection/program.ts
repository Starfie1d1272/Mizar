import {
  projectPlayerEquipment,
  projectTeamEconomy,
  type EquipmentCatalog,
  type PlayerEquipmentProjection,
  type TeamEconomyProjection,
} from './equipment.js';
import {
  projectBombDamage,
  type BombDamageProjection,
  type BombDamageResource,
} from './bomb-damage.js';
import { livePlayerDisplayName, matchPlayerDisplayName } from './player-display-name.js';
import {
  type ActiveLineupPlayer,
  type ActiveLineupResolution,
  type IdentityResolution,
  type IdentityState,
} from '../identity/index.js';
import type { MatchContext, MatchFormat, MatchVetoActionType } from '../match-context/index.js';
import { createSeriesProgress, safeAbsoluteRoundWins } from '../series-progress/index.js';
import type {
  SeriesMapProgress,
  SeriesMapSelection,
  SeriesProgress,
} from '../series-progress/index.js';
import type {
  BombState,
  CountdownPhase,
  MapPhase,
  RoundPhase,
  SourceSide,
  TelemetryCoverageStatus,
  WeaponState,
} from '../telemetry/index.js';
import {
  projectPlayerStatistics,
  type PlayerStatistics,
  getObjectiveClockLeaseMs,
  remainingFromObjectiveAnchor,
  type RuntimeContinuityPolicy,
} from '../runtime/index.js';
import {
  getProgramSafeRuntimeFreshness,
  type ProgramSafeRuntimeFreshness,
  type ProgramSafeRuntimeView,
} from './program-safe-runtime.js';
import type { ProjectionCursor } from './cursor.js';
import { getProjectionIdentityState, isProjectionIdentityCurrent } from './identity.js';
import { derivePlayerLifeState, type PlayerLifeState } from './player-life-state.js';

export interface ProgramTeamPresentationCanonical {
  readonly mode: 'canonical';
  readonly entryId: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly seriesScore: number | null;
}

export interface ProgramTeamPresentationNeutral {
  readonly mode: 'neutral';
  readonly entryId: null;
  readonly name: 'CT' | 'T';
  readonly logoUrl: null;
  readonly seriesScore: null;
}

export type ProgramTeamPresentation =
  ProgramTeamPresentationCanonical | ProgramTeamPresentationNeutral;

export interface ProgramSeriesEntrant {
  readonly entryId: string;
  readonly name: string;
  readonly logoUrl: string | null;
}

export interface ProgramSeriesMap {
  readonly mapId: string | null;
  readonly mapOrder: number;
  readonly mapName: string;
  readonly selection: SeriesMapSelection;
  readonly teamAStartSide: 'CT' | 'T' | null;
  readonly status: SeriesMapProgress['status'];
  readonly finalScore: SeriesMapProgress['finalScore'];
  readonly winnerEntryId: string | null;
}

export interface ProgramVetoStep {
  readonly stepOrder: number;
  readonly actionType: MatchVetoActionType;
  readonly mapName: string;
  readonly entryId: string | null;
  readonly side: 'CT' | 'T' | null;
}

export interface ProgramRoundHistoryItem {
  readonly roundNumber: number;
  readonly winnerSide: SourceSide;
  readonly winnerEntryId: string | null;
  readonly winCondition: 'elimination' | 'bomb' | 'defuse' | 'time' | 'unknown';
}

export interface ProgramSeriesProjection {
  readonly format: MatchFormat;
  readonly requiredWins: 1 | 2 | 3;
  readonly entrants: {
    readonly a: ProgramSeriesEntrant;
    readonly b: ProgramSeriesEntrant;
  };
  readonly score: { readonly a: number | null; readonly b: number | null };
  readonly resultDisposition?: 'recorded' | 'pending' | 'omitted' | null | undefined;
  readonly status: 'planned' | 'live' | 'completed';
  readonly bindingState: SeriesProgress['bindingState'];
  readonly currentMapOrder: number | null;
  readonly maps: readonly ProgramSeriesMap[];
  readonly veto: readonly ProgramVetoStep[];
  readonly roundHistory: null | {
    readonly mapOrder: number;
    readonly completeness: SeriesMapProgress['roundHistory']['completeness'];
    readonly rounds: readonly ProgramRoundHistoryItem[];
  };
}

export interface ProgramPlayerStateProjection {
  readonly health: number | null;
  readonly armor: number | null;
  readonly hasHelmet: boolean | null;
  readonly hasDefuser: boolean | null;
  readonly flashed: number | null;
  readonly smoked: number | null;
  readonly burning: number | null;
  readonly money: number | null;
  readonly roundTotalDamage: number | null;
  readonly roundKills: number | null;
  readonly roundKillHeadshots: number | null;
  readonly equipValue: number | null;
}

export interface ProgramMatchStatsProjection {
  readonly kills: number | null;
  readonly assists: number | null;
  readonly deaths: number | null;
  readonly mvps: number | null;
  readonly score: number | null;
}

export interface ProgramWeaponProjection {
  readonly sourceWeaponId: string;
  readonly name: string | null;
  readonly paintKit: string | null;
  readonly type: string | null;
  readonly ammoClip: number | null;
  readonly ammoClipMax: number | null;
  readonly ammoReserve: number | null;
  readonly state: WeaponState | null;
}

export interface ProgramPlayerProjection {
  readonly sourcePlayerId: string;
  readonly canonicalPlayerId: string | null;
  readonly identityEvidence: 'canonical' | 'observed' | 'unresolved';
  readonly lineupEvidence: 'current' | 'retained';
  readonly displayName: string | null;
  readonly displayNameSource: 'canonical' | 'observed' | 'unavailable';
  readonly avatarUrl: string | null;
  readonly side: SourceSide;
  readonly observerSlot: number | null;
  readonly activity: string | null;
  readonly lifeState: PlayerLifeState;
  readonly statistics: PlayerStatistics;
  readonly equipment: PlayerEquipmentProjection;
  readonly liveAdr: number | null;
  readonly completedAdr: number | null;
  readonly weaponsAvailable: boolean;
  readonly currentRoundDamage: number | null;
  readonly roundMoneySpent: number | null;
  readonly state: ProgramPlayerStateProjection | null;
  readonly matchStats: ProgramMatchStatsProjection | null;
  readonly weapons: readonly ProgramWeaponProjection[];
}

export interface ProgramObjectiveClockProjection {
  readonly remainingSeconds: number | null;
  readonly durationSeconds: number | null;
}

export type ProgramBombActionProjection =
  | {
      readonly kind: 'plant';
      readonly sourcePlayerId: string | null;
      readonly remainingSeconds: number | null;
      readonly durationSeconds: number | null;
    }
  | {
      readonly kind: 'defuse';
      readonly sourcePlayerId: string | null;
      readonly remainingSeconds: number | null;
      readonly durationSeconds: number | null;
      readonly hasDefuseKit: boolean | null;
    };

export interface ProgramBombProjection {
  readonly state: BombState | null;
  readonly sourcePlayerId: string | null;
  readonly explosion: ProgramObjectiveClockProjection | null;
  readonly action: ProgramBombActionProjection | null;
}

export interface ProgramProjection {
  readonly bombDamage: BombDamageProjection;
  readonly cursor: ProjectionCursor;
  readonly status: {
    readonly telemetry: ProgramSafeRuntimeFreshness;
    readonly context: 'unbound' | 'fresh' | 'stale';
    readonly identity: IdentityState;
  };
  readonly match: null | {
    readonly matchId: string;
    readonly competition: {
      readonly competitionId: string;
      readonly slug: string;
      readonly name: string;
      readonly themeColor: string | null;
    } | null;
    readonly format: MatchFormat;
    readonly stage: string | null;
  };
  readonly teams: {
    readonly ct: ProgramTeamPresentation;
    readonly t: ProgramTeamPresentation;
  };
  readonly teamEconomy: { readonly ct: TeamEconomyProjection; readonly t: TeamEconomyProjection };
  readonly series: ProgramSeriesProjection | null;
  readonly map: {
    readonly roundHistory?:
      | undefined
      | null
      | {
          readonly completeness: 'complete' | 'partial' | 'unavailable';
          readonly rounds: readonly ProgramRoundHistoryItem[];
        };
    readonly name: string | null;
    readonly mode: string | null;
    readonly phase: MapPhase | null;
    readonly roundNumber: number | null;
    readonly score: { readonly ct: number | null; readonly t: number | null };
    readonly timeoutsRemaining: {
      readonly ct: number | null;
      readonly t: number | null;
    };
    readonly consecutiveRoundLosses: {
      readonly ct: number | null;
      readonly t: number | null;
    };
  };
  readonly round: null | {
    readonly phase: RoundPhase | null;
    readonly winnerSide: SourceSide;
  };
  readonly clock: null | {
    readonly phase: CountdownPhase | null;
    readonly endsInSeconds: number | null;
  };
  readonly observedPlayerSourceId: string | null;
  readonly players: readonly ProgramPlayerProjection[];
  readonly bomb: null | ProgramBombProjection;
  readonly coverage: {
    readonly map: TelemetryCoverageStatus;
    readonly round: TelemetryCoverageStatus;
    readonly phaseCountdowns: TelemetryCoverageStatus;
    readonly player: TelemetryCoverageStatus;
    readonly allPlayers: TelemetryCoverageStatus;
    readonly bomb: TelemetryCoverageStatus;
  };
}

export interface ProgramProjectionInput {
  readonly equipmentCatalog?: EquipmentCatalog;
  readonly preferCanonicalPlayerNames?: boolean;
  readonly presentationRole?: 'gameplay';
  readonly bombDamageResource?: BombDamageResource;
  readonly runtime: ProgramSafeRuntimeView;
  readonly context?: MatchContext;
  readonly contextFreshness?: 'fresh' | 'stale';
  readonly identity: IdentityResolution;
  readonly activeLineup: ActiveLineupResolution;
  readonly nowMonotonicMs: number;
  readonly continuityPolicy: RuntimeContinuityPolicy;
  readonly seriesProgress?: SeriesProgress | null;
}

function nullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

function currentIdentityProof(
  runtime: ProgramSafeRuntimeView,
  identity: IdentityResolution,
): boolean {
  return isProjectionIdentityCurrent(runtime, identity);
}

function neutralTeam(name: 'CT' | 'T'): ProgramTeamPresentationNeutral {
  return { mode: 'neutral', entryId: null, name, logoUrl: null, seriesScore: null };
}

function canonicalTeams(
  context: MatchContext | undefined,
  seriesProgress: SeriesProgress | null | undefined,
  identity: IdentityResolution,
  identityIsCurrent: boolean,
): { readonly ct: ProgramTeamPresentation; readonly t: ProgramTeamPresentation } {
  const canUseBranding =
    context !== undefined &&
    identityIsCurrent &&
    identity.capabilities.canonicalTeamBranding &&
    identity.sideMapping.a !== 'unknown' &&
    identity.sideMapping.b !== 'unknown' &&
    identity.sideMapping.a !== identity.sideMapping.b;

  if (!canUseBranding || context === undefined) {
    return { ct: neutralTeam('CT'), t: neutralTeam('T') };
  }

  const bySide = {
    CT: identity.sideMapping.a === 'CT' ? context.entrants.a : context.entrants.b,
    T: identity.sideMapping.a === 'T' ? context.entrants.a : context.entrants.b,
  } as const;
  const seriesScoreFor = (entryId: string): number | null => {
    if (seriesProgress === null || seriesProgress === undefined) return null;
    if (seriesProgress.matchId !== context.matchId) return null;
    const score = seriesPresentationScore(context, seriesProgress);
    if (seriesProgress.entrants.a.entryId === entryId) return score.a;
    if (seriesProgress.entrants.b.entryId === entryId) return score.b;
    return null;
  };
  return {
    ct: {
      mode: 'canonical',
      entryId: bySide.CT.entryId,
      name: bySide.CT.name,
      logoUrl: bySide.CT.logoUrl,
      seriesScore: seriesScoreFor(bySide.CT.entryId),
    },
    t: {
      mode: 'canonical',
      entryId: bySide.T.entryId,
      name: bySide.T.name,
      logoUrl: bySide.T.logoUrl,
      seriesScore: seriesScoreFor(bySide.T.entryId),
    },
  };
}

/** Presentation consumes a confirmed conclusion separately from observed map progress. */
function seriesPresentationScore(context: MatchContext, progress: SeriesProgress) {
  if (context.status !== 'finished') return progress.score;
  if (context.resultDisposition === 'pending' || context.resultDisposition === 'omitted')
    return { a: null, b: null };
  return { a: context.scoreA, b: context.scoreB };
}

export function projectSeries(
  context: MatchContext | undefined,
  progress: SeriesProgress | null | undefined,
): ProgramSeriesProjection | null {
  if (context === undefined) return null;
  if (progress == null) {
    if (context.status !== 'finished') return null;
    progress = createSeriesProgress(context);
  }
  if (progress.matchId !== context.matchId) return null;

  const complete =
    progress.score.a >= progress.requiredWins || progress.score.b >= progress.requiredWins;
  const hasLiveEvidence =
    progress.bindingState === 'bound' ||
    progress.bindingState === 'needs_operator' ||
    progress.score.a > 0 ||
    progress.score.b > 0 ||
    progress.maps.some((map) => map.status === 'current' || map.status === 'completed');
  const currentMap =
    progress.currentMapOrder === null
      ? undefined
      : progress.maps.find((map) => map.mapOrder === progress.currentMapOrder);
  const historyMap =
    currentMap ??
    [...progress.maps]
      .reverse()
      .find((map) => map.status === 'completed' || map.roundHistory.rounds.length > 0);

  return {
    format: progress.format,
    requiredWins: progress.requiredWins,
    entrants: {
      a: { ...progress.entrants.a },
      b: { ...progress.entrants.b },
    },
    score: seriesPresentationScore(context, progress),
    resultDisposition:
      context.status === 'finished'
        ? (context.resultDisposition ??
          (context.scoreA !== null && context.scoreB !== null ? 'recorded' : 'pending'))
        : null,
    status:
      context.status === 'finished'
        ? 'completed'
        : complete
          ? 'completed'
          : hasLiveEvidence
            ? 'live'
            : 'planned',
    bindingState: progress.bindingState,
    currentMapOrder: progress.currentMapOrder,
    maps: progress.maps.map((map) => ({
      mapId: map.mapId,
      mapOrder: map.mapOrder,
      mapName: map.mapName,
      selection: { ...map.selection },
      teamAStartSide: map.teamAStartSide,
      status: map.status,
      finalScore: map.finalScore === null ? null : { ...map.finalScore },
      winnerEntryId: map.winnerEntryId,
    })),
    veto: context.veto.map((step) => ({
      stepOrder: step.stepOrder,
      actionType: step.actionType,
      mapName: step.mapName,
      entryId: step.entryId,
      side: step.side,
    })),
    roundHistory:
      historyMap === undefined
        ? null
        : {
            mapOrder: historyMap.mapOrder,
            completeness: historyMap.roundHistory.completeness,
            rounds: historyMap.roundHistory.rounds.map((round) => ({ ...round })),
          },
  };
}

function canonicalPlayerFor(
  sourcePlayerId: string,
  identity: IdentityResolution,
  identityIsCurrent: boolean,
) {
  if (
    !identityIsCurrent ||
    !identity.capabilities.canonicalPlayerMapping ||
    identity.state === 'mismatch'
  ) {
    return undefined;
  }
  return identity.players.find((player) => player.sourcePlayerId === sourcePlayerId);
}

function projectPlayer(
  lineupPlayer: ActiveLineupPlayer,
  identity: IdentityResolution,
  identityIsCurrent: boolean,
  playerStats: ProgramSafeRuntimeView['playerStats'],
  context: MatchContext | undefined,
  observedTeamName: string | undefined,
  liveNameIsCurrent: boolean,
  preferCanonicalPlayerNames: boolean,
  equipmentCatalog: EquipmentCatalog | undefined,
  telemetryFresh: boolean,
  bomb: ProgramBombProjection | null,
): ProgramPlayerProjection {
  const player = lineupPlayer.observed;
  const canonical = canonicalPlayerFor(lineupPlayer.sourcePlayerId, identity, identityIsCurrent);
  const observedDisplayName = player === null ? null : nullable(player.displayName);
  const canonicalDisplayName = canonical?.displayName ?? null;
  const entrant =
    canonical === undefined || context === undefined
      ? undefined
      : [context.entrants.a, context.entrants.b].find((item) => item.entryId === canonical.entryId);
  const { displayName, displayNameSource } = livePlayerDisplayName(
    liveNameIsCurrent ? observedDisplayName : null,
    preferCanonicalPlayerNames
      ? matchPlayerDisplayName(context, lineupPlayer.sourcePlayerId)
      : canonicalDisplayName,
    [entrant?.name, observedTeamName],
    preferCanonicalPlayerNames,
  );

  const state =
    player === null || player.state === undefined
      ? null
      : {
          health: nullable(player.state.health),
          armor: nullable(player.state.armor),
          hasHelmet: nullable(player.state.hasHelmet),
          hasDefuser: nullable(player.state.hasDefuser),
          flashed: nullable(player.state.flashed),
          smoked: nullable(player.state.smoked),
          burning: nullable(player.state.burning),
          money: nullable(player.state.money),
          roundTotalDamage: nullable(player.state.roundTotalDamage),
          roundKills: nullable(player.state.roundKills),
          roundKillHeadshots: nullable(player.state.roundKillHeadshots),
          equipValue: nullable(player.state.equipValue),
        };
  const statistics = projectPlayerStatistics(
    playerStats,
    lineupPlayer.sourcePlayerId,
    player?.matchStats,
    state?.money,
  );
  const matchStats =
    player === null || player.matchStats === undefined
      ? null
      : {
          kills: statistics.scoreboard.kills.value,
          assists: statistics.scoreboard.assists.value,
          deaths: statistics.scoreboard.deaths.value,
          mvps: nullable(player.matchStats.mvps),
          score: nullable(player.matchStats.score),
        };

  const lifeState = player === null ? 'unknown' : derivePlayerLifeState(player.state?.health);
  return {
    sourcePlayerId: lineupPlayer.sourcePlayerId,
    canonicalPlayerId: canonical?.canonicalPlayerId ?? null,
    identityEvidence:
      canonical === undefined && lineupPlayer.identityEvidence === 'canonical'
        ? 'unresolved'
        : lineupPlayer.identityEvidence,
    lineupEvidence: lineupPlayer.lineupEvidence,
    displayName,
    displayNameSource,
    avatarUrl: canonical?.avatarUrl ?? null,
    side: lineupPlayer.side,
    observerSlot: player === null ? null : nullable(player.observerSlot),
    activity: player === null ? null : nullable(player.activity),
    lifeState,
    statistics,
    equipment: projectPlayerEquipment(player?.weapons, equipmentCatalog, {
      sourcePlayerId: lineupPlayer.sourcePlayerId,
      bomb,
      telemetryFresh,
      lineupCurrent: lineupPlayer.lineupEvidence === 'current',
      lifeState,
    }),
    liveAdr: statistics.includingCurrentRound.adr.value,
    completedAdr: statistics.completed.adr.value,
    weaponsAvailable: player !== null && player.weapons !== undefined,
    currentRoundDamage: statistics.currentRound.damage.value,
    roundMoneySpent: statistics.currentRound.moneySpent.value,
    state,
    matchStats,
    weapons: [...(player?.weapons ?? [])]
      .sort((left, right) => left.sourceWeaponId.localeCompare(right.sourceWeaponId))
      .map((weapon) => ({
        sourceWeaponId: weapon.sourceWeaponId,
        name: nullable(weapon.name),
        paintKit: nullable(weapon.paintKit),
        type: nullable(weapon.type),
        ammoClip: nullable(weapon.ammoClip),
        ammoClipMax: nullable(weapon.ammoClipMax),
        ammoReserve: nullable(weapon.ammoReserve),
        state: nullable(weapon.state),
      })),
  };
}

function finiteNonNegative(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : Math.max(0, value);
}

function objectiveSampleIsCurrent(runtime: ProgramSafeRuntimeView): boolean {
  const receiveSequence = runtime.cursor.programReceiveSequence;
  return (
    runtime.telemetry !== null &&
    runtime.telemetry.coverage.bomb === 'present' &&
    receiveSequence !== null &&
    runtime.objectiveTiming.sourceGeneration === runtime.cursor.programSourceGeneration &&
    runtime.objectiveTiming.mapEpoch === runtime.cursor.mapEpoch &&
    runtime.objectiveTiming.lastAcceptedReceiveSequence === receiveSequence
  );
}

function currentDefuseKit(
  telemetry: ProgramSafeRuntimeView['telemetry'],
  sourcePlayerId: string | null,
): boolean | null {
  if (telemetry === null || sourcePlayerId === null) return null;
  const candidates = [
    ...(telemetry.telemetry.allPlayers ?? []),
    ...(telemetry.telemetry.player === undefined ? [] : [telemetry.telemetry.player]),
  ];
  const evidence = candidates
    .filter((candidate) => candidate.sourcePlayerId === sourcePlayerId)
    .map((candidate) => candidate.state?.hasDefuser)
    .filter((value): value is boolean => value !== undefined);
  if (evidence.length === 0) return null;
  const values = new Set(evidence);
  return values.size === 1 ? evidence[0]! : null;
}

function roundIsOver(runtime: ProgramSafeRuntimeView): boolean {
  return (
    runtime.telemetry?.coverage.round === 'present' &&
    runtime.telemetry.telemetry.round?.phase === 'over'
  );
}

function projectBomb(
  runtime: ProgramSafeRuntimeView,
  nowMonotonicMs: number,
  continuityPolicy: RuntimeContinuityPolicy,
): ProgramBombProjection | null {
  const bomb = runtime.telemetry?.telemetry.bomb;
  if (bomb === undefined) return null;

  const state = nullable(bomb.state);
  const sourcePlayerId = nullable(bomb.sourcePlayerId);
  if (roundIsOver(runtime)) {
    return { state, sourcePlayerId, explosion: null, action: null };
  }
  if (!objectiveSampleIsCurrent(runtime)) {
    return { state, sourcePlayerId, explosion: null, action: null };
  }

  const lastAccepted = runtime.programSourceLastAccepted;
  const objectiveClockLive =
    lastAccepted !== null &&
    getProgramSafeRuntimeFreshness(runtime, nowMonotonicMs, continuityPolicy) === 'fresh' &&
    nowMonotonicMs - lastAccepted.receivedMonotonicMs <= getObjectiveClockLeaseMs(continuityPolicy);
  const explosionAnchor = runtime.objectiveTiming.explosionAnchor;
  const explosion =
    explosionAnchor === null
      ? null
      : {
          remainingSeconds: objectiveClockLive
            ? remainingFromObjectiveAnchor(explosionAnchor, nowMonotonicMs)
            : null,
          durationSeconds: runtime.objectiveTiming.explosionDurationSeconds,
        };
  const remainingSeconds =
    objectiveClockLive && lastAccepted !== null && bomb.countdownSeconds !== undefined
      ? finiteNonNegative(
          bomb.countdownSeconds - (nowMonotonicMs - lastAccepted.receivedMonotonicMs) / 1_000,
        )
      : null;

  let action: ProgramBombActionProjection | null = null;
  switch (bomb.state ?? 'unknown') {
    case 'planting':
      action = {
        kind: 'plant',
        sourcePlayerId,
        remainingSeconds,
        durationSeconds: runtime.objectiveTiming.plantActionDurationSeconds,
      };
      break;
    case 'defusing': {
      const hasDefuseKit = currentDefuseKit(runtime.telemetry, sourcePlayerId);
      action = {
        kind: 'defuse',
        sourcePlayerId,
        remainingSeconds,
        durationSeconds:
          hasDefuseKit === true
            ? 5
            : hasDefuseKit === false
              ? 10
              : runtime.objectiveTiming.defuseActionDurationSeconds,
        hasDefuseKit,
      };
      break;
    }
    default:
      break;
  }

  return { state, sourcePlayerId, explosion, action };
}

export function projectProgram(input: ProgramProjectionInput): ProgramProjection {
  const telemetry = input.runtime.telemetry;
  const contextFreshness =
    input.context === undefined ? 'unbound' : (input.contextFreshness ?? 'fresh');
  const telemetryFreshness = getProgramSafeRuntimeFreshness(
    input.runtime,
    input.nowMonotonicMs,
    input.continuityPolicy,
  );
  const identityIsCurrent = currentIdentityProof(input.runtime, input.identity);
  const map = telemetry?.telemetry.map;
  const round = telemetry?.telemetry.round;
  const countdown = telemetry?.telemetry.phaseCountdowns;
  const unboundGameplay =
    input.presentationRole === 'gameplay' &&
    telemetryFreshness === 'fresh' &&
    map?.name !== undefined &&
    (input.seriesProgress?.bindingState !== 'bound' || input.identity.state === 'mismatch');
  const activeLineup = input.activeLineup;
  const activeLineupIsCurrent =
    activeLineup.sourceGeneration === input.runtime.cursor.programSourceGeneration &&
    activeLineup.mapEpoch === input.runtime.cursor.mapEpoch;
  const players = activeLineupIsCurrent
    ? [...activeLineup.ct, ...activeLineup.t].sort((left, right) =>
        left.sourcePlayerId.localeCompare(right.sourcePlayerId),
      )
    : [];

  const bomb = projectBomb(input.runtime, input.nowMonotonicMs, input.continuityPolicy);
  const projectedPlayers = players.map((player) =>
    projectPlayer(
      player,
      input.identity,
      identityIsCurrent && !unboundGameplay,
      input.runtime.playerStats,
      input.context,
      telemetryFreshness === 'fresh' &&
        telemetry?.coverage.map === 'present' &&
        player.observed?.side === player.side
        ? player.side === 'CT'
          ? map?.sides?.ct?.name
          : map?.sides?.t?.name
        : undefined,
      telemetryFreshness === 'fresh' && telemetry?.coverage.allPlayers === 'present',
      input.preferCanonicalPlayerNames === true,
      input.equipmentCatalog,
      telemetryFreshness === 'fresh',
      bomb,
    ),
  );
  const economyFor = (side: 'CT' | 'T') =>
    projectTeamEconomy(
      projectedPlayers
        .filter((p) => p.side === side)
        .map((p) => ({
          current: p.lineupEvidence === 'current' && telemetryFreshness === 'fresh',
          lifeState: p.lifeState,
          money: p.state?.money ?? null,
          equipmentValue: p.state?.equipValue ?? null,
          equipment: p.equipment,
        })),
      round?.phase ?? null,
      telemetryFreshness !== 'fresh'
        ? null
        : side === 'CT'
          ? (map?.sides?.ct?.consecutiveRoundLosses ?? null)
          : (map?.sides?.t?.consecutiveRoundLosses ?? null),
    );

  return {
    cursor: input.runtime.cursor,
    bombDamage: projectBombDamage(input),
    status: {
      telemetry: telemetryFreshness,
      context: contextFreshness,
      identity: getProjectionIdentityState(input.runtime, input.identity),
    },
    match:
      input.context === undefined || unboundGameplay
        ? null
        : {
            matchId: input.context.matchId,
            competition:
              input.context.competition === null
                ? null
                : {
                    ...input.context.competition,
                    slug: input.context.competition.slug ?? input.context.competition.competitionId,
                  },
            format: input.context.format,
            stage: input.context.stageLabel ?? input.context.stage,
          },
    teams: canonicalTeams(
      unboundGameplay ? undefined : input.context,
      input.seriesProgress,
      input.identity,
      identityIsCurrent,
    ),
    series: unboundGameplay ? null : projectSeries(input.context, input.seriesProgress),
    map: {
      roundHistory:
        telemetryFreshness === 'fresh' &&
        safeAbsoluteRoundWins({
          roundWins: map?.roundWins ?? [],
          score: { ct: nullable(map?.sides?.ct?.score), t: nullable(map?.sides?.t?.score) },
        })
          ? {
              completeness: 'complete',
              rounds: (map?.roundWins ?? []).map((win) => ({ ...win, winnerEntryId: null })),
            }
          : null,
      name: nullable(map?.name),
      mode: nullable(map?.mode),
      phase: nullable(map?.phase),
      roundNumber: nullable(map?.roundNumber),
      score: {
        ct: nullable(map?.sides?.ct?.score),
        t: nullable(map?.sides?.t?.score),
      },
      timeoutsRemaining: {
        ct: nullable(map?.sides?.ct?.timeoutsRemaining),
        t: nullable(map?.sides?.t?.timeoutsRemaining),
      },
      consecutiveRoundLosses: {
        ct: nullable(map?.sides?.ct?.consecutiveRoundLosses),
        t: nullable(map?.sides?.t?.consecutiveRoundLosses),
      },
    },
    round:
      round === undefined
        ? null
        : { phase: nullable(round.phase), winnerSide: round.winnerSide ?? 'unknown' },
    clock:
      countdown === undefined
        ? null
        : { phase: nullable(countdown.phase), endsInSeconds: nullable(countdown.endsInSeconds) },
    observedPlayerSourceId: telemetry?.telemetry.player?.sourcePlayerId ?? null,
    players: projectedPlayers,
    teamEconomy: { ct: economyFor('CT'), t: economyFor('T') },
    bomb,
    coverage: {
      map: telemetry?.coverage.map ?? 'absent',
      round: telemetry?.coverage.round ?? 'absent',
      phaseCountdowns: telemetry?.coverage.phaseCountdowns ?? 'absent',
      player: telemetry?.coverage.player ?? 'absent',
      allPlayers: telemetry?.coverage.allPlayers ?? 'absent',
      bomb: telemetry?.coverage.bomb ?? 'absent',
    },
  };
}
