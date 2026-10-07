import type { ObservedPlayer, RoundPhase, TelemetryObservation } from '../telemetry/index.js';

const STEAM64_PATTERN = /^\d{17}$/;

/** The first version only needs to retain the small bounded player cohort of one map. */
export const MAX_TRACKED_MAP_PLAYERS = 64;

export type DamageBySteam64 = Readonly<Record<string, number>>;

export interface MapPlayerStatsCurrentRound {
  /** A continuity hint only; map.round is not the round identity authority. */
  readonly roundNumberHint: number | null;
  readonly phase: RoundPhase;
  readonly eligible: boolean;
  readonly invalidated: boolean;
  readonly hasCompleteEvidence: boolean;
  readonly damageBySteam64: DamageBySteam64;
  /** First healthy freezetime money observation for this round. */
  readonly startMoneyBySteam64: Readonly<Record<string, number>>;
}

export interface MapPlayerStatsAccumulator {
  readonly mapEpoch: number;
  readonly countedCompletedRounds: number;
  readonly currentRound: MapPlayerStatsCurrentRound | null;
  readonly completedDamageBySteam64: DamageBySteam64;
}

export type MapPlayerStatsFrameContinuity =
  'baseline' | 'contiguous' | 'gap-resync' | 'stale-recovery';

export interface MapPlayerStatsTelemetryInput {
  readonly mapEpoch: number;
  readonly observation: TelemetryObservation;
  readonly continuity: MapPlayerStatsFrameContinuity;
}

function emptyDamage(): DamageBySteam64 {
  return {};
}

function sortedDamage(damage: DamageBySteam64): DamageBySteam64 {
  return Object.fromEntries(
    Object.entries(damage).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function isValidSteam64(sourcePlayerId: string): boolean {
  return STEAM64_PATTERN.test(sourcePlayerId);
}

function roundNumberHintFromObservation(observation: TelemetryObservation): number | null {
  const roundNumber = observation.telemetry.map?.roundNumber;
  return roundNumber !== undefined && Number.isSafeInteger(roundNumber) ? roundNumber : null;
}

function roundPhaseFromObservation(observation: TelemetryObservation): RoundPhase {
  if (observation.coverage.round !== 'present') return 'unknown';
  return observation.telemetry.round?.phase ?? 'unknown';
}

function hasCompleteAllPlayersEvidence(observation: TelemetryObservation): boolean {
  return (
    observation.coverage.allPlayers === 'present' && observation.telemetry.allPlayers !== undefined
  );
}

function createCurrentRound(
  observation: TelemetryObservation,
  invalidated: boolean,
): MapPlayerStatsCurrentRound {
  return {
    roundNumberHint: roundNumberHintFromObservation(observation),
    phase: roundPhaseFromObservation(observation),
    eligible: false,
    invalidated,
    hasCompleteEvidence: !invalidated && hasCompleteAllPlayersEvidence(observation),
    damageBySteam64: emptyDamage(),
    startMoneyBySteam64: {},
  };
}

function copyPlayerDamage(
  current: DamageBySteam64,
  players: readonly ObservedPlayer[],
): DamageBySteam64 {
  const next = { ...current };
  for (const player of [...players].sort((left, right) =>
    left.sourcePlayerId < right.sourcePlayerId
      ? -1
      : left.sourcePlayerId > right.sourcePlayerId
        ? 1
        : 0,
  )) {
    const sourcePlayerId = player.sourcePlayerId;
    if (!isValidSteam64(sourcePlayerId)) continue;
    const roundTotalDamage = player.state?.roundTotalDamage;
    if (
      roundTotalDamage === undefined ||
      !Number.isFinite(roundTotalDamage) ||
      roundTotalDamage < 0
    ) {
      continue;
    }
    if (next[sourcePlayerId] === undefined && Object.keys(next).length >= MAX_TRACKED_MAP_PLAYERS) {
      continue;
    }
    next[sourcePlayerId] = Math.max(next[sourcePlayerId] ?? 0, roundTotalDamage);
  }
  return sortedDamage(next);
}

function copyStartMoney(
  current: Readonly<Record<string, number>>,
  players: readonly ObservedPlayer[],
): Readonly<Record<string, number>> {
  const next = { ...current };
  for (const player of [...players].sort((left, right) =>
    left.sourcePlayerId < right.sourcePlayerId
      ? -1
      : left.sourcePlayerId > right.sourcePlayerId
        ? 1
        : 0,
  )) {
    const sourcePlayerId = player.sourcePlayerId;
    if (!isValidSteam64(sourcePlayerId) || next[sourcePlayerId] !== undefined) continue;
    const money = player.state?.money;
    if (money === undefined || !Number.isFinite(money) || money < 0) continue;
    if (Object.keys(next).length >= MAX_TRACKED_MAP_PLAYERS) continue;
    next[sourcePlayerId] = money;
  }
  return sortedDamage(next);
}

function addCompletedRound(
  accumulator: MapPlayerStatsAccumulator,
  currentRound: MapPlayerStatsCurrentRound,
): MapPlayerStatsAccumulator {
  const completed = { ...accumulator.completedDamageBySteam64 };
  for (const [sourcePlayerId, damage] of Object.entries(currentRound.damageBySteam64)) {
    if (
      completed[sourcePlayerId] === undefined &&
      Object.keys(completed).length >= MAX_TRACKED_MAP_PLAYERS
    ) {
      continue;
    }
    completed[sourcePlayerId] = (completed[sourcePlayerId] ?? 0) + damage;
  }
  return {
    ...accumulator,
    countedCompletedRounds: accumulator.countedCompletedRounds + 1,
    currentRound: null,
    completedDamageBySteam64: sortedDamage(completed),
  };
}

function invalidateCurrentRound(
  currentRound: MapPlayerStatsCurrentRound,
): MapPlayerStatsCurrentRound {
  return {
    ...currentRound,
    eligible: false,
    invalidated: true,
    hasCompleteEvidence: false,
    damageBySteam64: emptyDamage(),
    startMoneyBySteam64: {},
  };
}

/**
 * Invalidate only the in-flight round. Completed map stats remain trustworthy
 * across a source gap/reconnect; the next complete observed round establishes
 * a fresh eligible baseline.
 */
export function invalidateMapPlayerStats(
  accumulator: MapPlayerStatsAccumulator,
): MapPlayerStatsAccumulator {
  if (accumulator.currentRound === null) return accumulator;
  return { ...accumulator, currentRound: invalidateCurrentRound(accumulator.currentRound) };
}

function sameRoundHint(
  currentRound: MapPlayerStatsCurrentRound,
  nextRoundNumber: number | null,
): boolean {
  return (
    currentRound.roundNumberHint === null ||
    nextRoundNumber === null ||
    currentRound.roundNumberHint === nextRoundNumber
  );
}

/**
 * CS GSI's map.round is retained as a sanity hint only. Depending on the
 * provider lifecycle, phase=over may already report the next completed-round
 * count (for example freezetime/live round 0 followed by over round 1).
 */
function acceptableRoundEndHint(
  currentRound: MapPlayerStatsCurrentRound,
  nextRoundNumber: number | null,
): boolean {
  return (
    currentRound.roundNumberHint === null ||
    nextRoundNumber === null ||
    nextRoundNumber === currentRound.roundNumberHint ||
    nextRoundNumber === currentRound.roundNumberHint + 1
  );
}

export function createMapPlayerStatsAccumulator(mapEpoch = 0): MapPlayerStatsAccumulator {
  return {
    mapEpoch,
    countedCompletedRounds: 0,
    currentRound: null,
    completedDamageBySteam64: emptyDamage(),
  };
}

export function reduceMapPlayerStats(
  previous: MapPlayerStatsAccumulator,
  input: MapPlayerStatsTelemetryInput,
): MapPlayerStatsAccumulator {
  const startsNewMap = previous.mapEpoch !== input.mapEpoch;
  const accumulator = startsNewMap ? createMapPlayerStatsAccumulator(input.mapEpoch) : previous;
  const phase = roundPhaseFromObservation(input.observation);
  const mapEnded =
    input.observation.coverage.map === 'present' &&
    input.observation.telemetry.map?.phase === 'gameover';
  const endsRound = phase === 'over' || mapEnded;
  const roundNumberHint = roundNumberHintFromObservation(input.observation);
  const healthyFrame =
    startsNewMap || input.continuity === 'baseline' || input.continuity === 'contiguous';
  const completeEvidence = hasCompleteAllPlayersEvidence(input.observation);

  let currentRound = accumulator.currentRound;
  if (!startsNewMap && !healthyFrame && currentRound !== null) {
    currentRound = invalidateCurrentRound(currentRound);
  }

  if (currentRound !== null && phase !== 'unknown') {
    const roundHintChanged =
      currentRound.roundNumberHint !== null &&
      roundNumberHint !== null &&
      currentRound.roundNumberHint !== roundNumberHint;

    if (endsRound) {
      if (!acceptableRoundEndHint(currentRound, roundNumberHint)) {
        currentRound = invalidateCurrentRound(currentRound);
      }
    } else if (roundHintChanged) {
      // A phase transition, rather than map.round, owns round lifecycle. A
      // new freezetime can start a fresh baseline; a jump during live is a
      // fail-closed continuity break for the current round.
      currentRound = phase === 'freezetime' ? null : invalidateCurrentRound(currentRound);
    } else if (phase === 'freezetime' && currentRound.phase !== 'freezetime') {
      currentRound = null;
    }
  }

  if (currentRound === null && (phase === 'freezetime' || phase === 'live')) {
    currentRound = createCurrentRound(
      input.observation,
      !healthyFrame || !completeEvidence || phase === 'live',
    );
  }

  if (currentRound === null) return { ...accumulator, currentRound: null };

  const invalidated = currentRound.invalidated || !healthyFrame || !completeEvidence;
  const phaseForState = phase === 'unknown' ? currentRound.phase : phase;
  const canPromoteToEligible =
    !invalidated &&
    currentRound.phase === 'freezetime' &&
    phase === 'live' &&
    currentRound.hasCompleteEvidence &&
    sameRoundHint(currentRound, roundNumberHint);
  const hasCompleteEvidence = !invalidated && completeEvidence && currentRound.hasCompleteEvidence;
  const damageBySteam64 = invalidated
    ? emptyDamage()
    : copyPlayerDamage(currentRound.damageBySteam64, input.observation.telemetry.allPlayers ?? []);
  const startMoneyBySteam64 =
    !invalidated &&
    phase === 'freezetime' &&
    currentRound.phase === 'freezetime' &&
    completeEvidence
      ? copyStartMoney(
          currentRound.startMoneyBySteam64,
          input.observation.telemetry.allPlayers ?? [],
        )
      : currentRound.startMoneyBySteam64;
  currentRound = {
    ...currentRound,
    phase: phaseForState,
    eligible: canPromoteToEligible ? true : currentRound.eligible && !invalidated,
    invalidated,
    hasCompleteEvidence,
    damageBySteam64,
    startMoneyBySteam64,
  };

  if (endsRound) {
    if (currentRound.eligible && currentRound.hasCompleteEvidence && !currentRound.invalidated) {
      return addCompletedRound(accumulator, currentRound);
    }
    return { ...accumulator, currentRound: null };
  }

  return { ...accumulator, currentRound };
}

function currentRoundIsCounted(accumulator: MapPlayerStatsAccumulator): boolean {
  return (
    accumulator.currentRound?.eligible === true &&
    accumulator.currentRound.invalidated === false &&
    accumulator.currentRound.hasCompleteEvidence === true
  );
}

export function getPlayerCompletedAdr(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
): number | null {
  if (!isValidSteam64(sourcePlayerId) || accumulator.countedCompletedRounds === 0) return null;
  return (
    (accumulator.completedDamageBySteam64[sourcePlayerId] ?? 0) / accumulator.countedCompletedRounds
  );
}

export function getPlayerLiveAdr(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
): number | null {
  if (!isValidSteam64(sourcePlayerId)) return null;
  const includesCurrentRound = currentRoundIsCounted(accumulator);
  const denominator = accumulator.countedCompletedRounds + (includesCurrentRound ? 1 : 0);
  if (denominator === 0) return null;
  const currentDamage = includesCurrentRound
    ? (accumulator.currentRound?.damageBySteam64[sourcePlayerId] ?? 0)
    : 0;
  return (
    ((accumulator.completedDamageBySteam64[sourcePlayerId] ?? 0) + currentDamage) / denominator
  );
}

/**
 * Return only damage observed in the current round. A continuity or evidence
 * gap makes the in-flight value unavailable instead of exposing a partial fact.
 */
export function getPlayerCurrentRoundDamage(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
): number | null {
  if (!isValidSteam64(sourcePlayerId)) return null;
  const currentRound = accumulator.currentRound;
  if (currentRound === null || currentRound.invalidated || !currentRound.hasCompleteEvidence) {
    return null;
  }
  return currentRound.damageBySteam64[sourcePlayerId] ?? null;
}

/**
 * Freezetime presentation fact: max(0, first healthy freezetime money - now).
 * The baseline belongs to the map-scoped accumulator, never to React state.
 */
export function getPlayerCurrentRoundMoneySpent(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
  currentMoney: number | null | undefined,
): number | null {
  if (!isValidSteam64(sourcePlayerId) || currentMoney === null || currentMoney === undefined) {
    return null;
  }
  if (!Number.isFinite(currentMoney) || currentMoney < 0) return null;
  const currentRound = accumulator.currentRound;
  if (
    currentRound === null ||
    currentRound.phase !== 'freezetime' ||
    currentRound.invalidated ||
    !currentRound.hasCompleteEvidence
  ) {
    return null;
  }
  const startMoney = currentRound.startMoneyBySteam64[sourcePlayerId];
  if (startMoney === undefined) return null;
  return Math.max(0, startMoney - currentMoney);
}
