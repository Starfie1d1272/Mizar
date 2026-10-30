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
  /** Damage fields actually present in the most recent accepted frame. */
  readonly latestDamageBySteam64: DamageBySteam64;
  readonly roster: Readonly<Record<string, 'CT' | 'T'>>;
  /** First healthy freezetime money observation for this round. */
  readonly startMoneyBySteam64: Readonly<Record<string, number>>;
}

/** Parser-neutral subset of a death event; adapters preserve the original game cursor. */
export interface ProgramRoundDeathEvent {
  readonly kind: 'player-death';
  readonly cursor: {
    readonly kind: 'cs2-cstv';
    readonly role: 'program' | 'lookahead';
    readonly generation: number;
    readonly sequence: number;
    readonly tick: number;
    readonly observedAt: string;
    readonly observedMonotonicMs: number;
    readonly mapName?: string;
    readonly ticksPerSecond?: number;
  };
  readonly victim: { readonly sourcePlayerId?: string };
  readonly attacker?: { readonly sourcePlayerId?: string };
  readonly assister?: { readonly sourcePlayerId?: string };
}

export interface CompletedPlayerRound {
  readonly roundNumberHint: number | null;
  readonly complete: boolean;
  readonly roster: Readonly<Record<string, 'CT' | 'T'>>;
  readonly damageBySteam64: DamageBySteam64;
  readonly terminalScore: { readonly ct: number; readonly t: number } | null;
  readonly players: Readonly<
    Record<
      string,
      { readonly side: 'CT' | 'T'; readonly damage: number; readonly survived: boolean }
    >
  >;
  readonly deaths: readonly ProgramRoundDeathEvent[] | null;
}

/** Adapter asserts complete event coverage and alignment to this GSI map execution/round. */
export interface TrustedProgramRoundEvents {
  readonly mapEpoch: number;
  readonly roundNumberHint: number;
  readonly coverage: 'complete';
  readonly source: {
    readonly role: 'program';
    readonly generation: number;
    readonly ticksPerSecond: number;
    readonly startTick: number;
    readonly endTick: number;
  };
  readonly deaths: readonly ProgramRoundDeathEvent[];
}

export interface MapPlayerStatsAccumulator {
  readonly mapEpoch: number;
  readonly countedCompletedRounds: number;
  /** Source continuity; metric projections also account for incomplete round samples. */
  readonly coverage: 'complete' | 'partial';
  readonly currentRound: MapPlayerStatsCurrentRound | null;
  readonly completedDamageBySteam64: DamageBySteam64;
  readonly completedRounds: readonly CompletedPlayerRound[];
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
    latestDamageBySteam64: emptyDamage(),
    roster: Object.fromEntries(
      (observation.telemetry.allPlayers ?? []).flatMap((p) =>
        isValidSteam64(p.sourcePlayerId) && (p.side === 'CT' || p.side === 'T')
          ? [[p.sourcePlayerId, p.side]]
          : [],
      ),
    ),
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
  observation: TelemetryObservation,
): MapPlayerStatsAccumulator {
  const players = observation.telemetry.allPlayers ?? [];
  const ct = observation.telemetry.map?.sides?.ct?.score;
  const t = observation.telemetry.map?.sides?.t?.score;
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
    completedRounds: [
      ...accumulator.completedRounds,
      {
        roundNumberHint: currentRound.roundNumberHint,
        roster: currentRound.roster,
        damageBySteam64: currentRound.damageBySteam64,
        terminalScore:
          ct !== undefined &&
          t !== undefined &&
          Number.isSafeInteger(ct) &&
          ct >= 0 &&
          Number.isSafeInteger(t) &&
          t >= 0
            ? { ct, t }
            : null,
        complete:
          players.length > 0 &&
          new Set(players.map((p) => p.sourcePlayerId)).size === players.length &&
          players.every(
            (p) =>
              isValidSteam64(p.sourcePlayerId) &&
              (p.side === 'CT' || p.side === 'T') &&
              currentRound.damageBySteam64[p.sourcePlayerId] !== undefined &&
              p.state?.roundTotalDamage !== undefined &&
              Number.isFinite(p.state.roundTotalDamage) &&
              p.state.roundTotalDamage >= 0 &&
              p.state?.health !== undefined &&
              Number.isFinite(p.state.health) &&
              p.state.health >= 0,
          ),
        players: Object.fromEntries(
          players.flatMap((player) => {
            const damage = currentRound.damageBySteam64[player.sourcePlayerId];
            const health = player.state?.health;
            if (
              !isValidSteam64(player.sourcePlayerId) ||
              (player.side !== 'CT' && player.side !== 'T') ||
              damage === undefined ||
              health === undefined ||
              !Number.isFinite(health) ||
              health < 0
            )
              return [];
            return [[player.sourcePlayerId, { side: player.side, damage, survived: health > 0 }]];
          }),
        ),
        deaths: null,
      },
    ],
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
    latestDamageBySteam64: emptyDamage(),
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
  if (accumulator.currentRound === null) return { ...accumulator, coverage: 'partial' };
  return {
    ...accumulator,
    coverage: 'partial',
    currentRound: invalidateCurrentRound(accumulator.currentRound),
  };
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
    coverage: 'complete',
    currentRound: null,
    completedDamageBySteam64: emptyDamage(),
    completedRounds: [],
  };
}

export function reduceMapPlayerStats(
  previous: MapPlayerStatsAccumulator,
  input: MapPlayerStatsTelemetryInput,
): MapPlayerStatsAccumulator {
  const startsNewMap = previous.mapEpoch !== input.mapEpoch;
  let accumulator = startsNewMap ? createMapPlayerStatsAccumulator(input.mapEpoch) : previous;
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
  if (
    !healthyFrame ||
    (accumulator.countedCompletedRounds === 0 &&
      currentRound === null &&
      (roundNumberHint === null || roundNumberHint > 0 || phase === 'live' || endsRound))
  )
    accumulator = { ...accumulator, coverage: 'partial' };
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

  if (currentRound === null && !mapEnded && (phase === 'freezetime' || phase === 'live')) {
    currentRound = createCurrentRound(
      input.observation,
      !healthyFrame || !completeEvidence || phase === 'live',
    );
  }

  if (currentRound === null) {
    return settleTerminalRound(accumulator, input);
  }

  const observedPlayers = input.observation.telemetry.allPlayers ?? [];
  const sameRoster =
    observedPlayers.length > 0 &&
    observedPlayers.length === Object.keys(currentRound.roster).length &&
    new Set(observedPlayers.map((p) => p.sourcePlayerId)).size === observedPlayers.length &&
    observedPlayers.every(
      (p) =>
        currentRound!.roster[p.sourcePlayerId] !== undefined &&
        currentRound!.roster[p.sourcePlayerId] === p.side,
    );
  const invalidated = currentRound.invalidated || !healthyFrame || !completeEvidence || !sameRoster;
  if (invalidated) accumulator = { ...accumulator, coverage: 'partial' };
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
    latestDamageBySteam64: invalidated
      ? emptyDamage()
      : copyPlayerDamage(emptyDamage(), observedPlayers),
    startMoneyBySteam64,
  };

  if (endsRound) {
    if (currentRound.eligible && currentRound.hasCompleteEvidence && !currentRound.invalidated) {
      return addCompletedRound(accumulator, currentRound, input.observation);
    }
    return { ...accumulator, currentRound: null };
  }

  return { ...accumulator, currentRound };
}

/** Late gameover observations can fill an incomplete terminal sample only under the same score, roster and contiguous GSI source. */
function settleTerminalRound(
  accumulator: MapPlayerStatsAccumulator,
  input: MapPlayerStatsTelemetryInput,
): MapPlayerStatsAccumulator {
  if (
    input.continuity !== 'contiguous' ||
    input.observation.coverage.map !== 'present' ||
    input.observation.telemetry.map?.phase !== 'gameover' ||
    input.observation.coverage.allPlayers !== 'present'
  )
    return accumulator;
  const round = accumulator.completedRounds.at(-1);
  const players = input.observation.telemetry.allPlayers;
  const map = input.observation.telemetry.map;
  if (
    !round ||
    round.complete ||
    round.roundNumberHint === null ||
    round.terminalScore === null ||
    !players ||
    map.sides?.ct?.score !== round.terminalScore.ct ||
    map.sides.t?.score !== round.terminalScore.t ||
    (map.roundNumber !== round.roundNumberHint && map.roundNumber !== round.roundNumberHint + 1) ||
    players.length !== Object.keys(round.roster).length ||
    new Set(players.map((p) => p.sourcePlayerId)).size !== players.length ||
    !players.every(
      (p) =>
        round.roster[p.sourcePlayerId] === p.side &&
        p.state?.roundTotalDamage !== undefined &&
        Number.isFinite(p.state.roundTotalDamage) &&
        p.state.roundTotalDamage >= 0 &&
        p.state.health !== undefined &&
        Number.isFinite(p.state.health) &&
        p.state.health >= 0 &&
        round.damageBySteam64[p.sourcePlayerId] !== undefined,
    )
  )
    return accumulator;
  const damage = copyPlayerDamage(round.damageBySteam64, players);
  const completedDamage = { ...accumulator.completedDamageBySteam64 };
  for (const p of players)
    completedDamage[p.sourcePlayerId] =
      (completedDamage[p.sourcePlayerId] ?? 0) +
      damage[p.sourcePlayerId]! -
      round.damageBySteam64[p.sourcePlayerId]!;
  const settled: CompletedPlayerRound = {
    ...round,
    complete: true,
    damageBySteam64: damage,
    players: Object.fromEntries(
      players.map((p) => [
        p.sourcePlayerId,
        {
          side: round.roster[p.sourcePlayerId]!,
          damage: damage[p.sourcePlayerId]!,
          survived: p.state!.health! > 0,
        },
      ]),
    ),
  };
  return {
    ...accumulator,
    completedDamageBySteam64: sortedDamage(completedDamage),
    completedRounds: [...accumulator.completedRounds.slice(0, -1), settled],
  };
}

function currentRoundIsCounted(accumulator: MapPlayerStatsAccumulator): boolean {
  return (
    accumulator.currentRound?.eligible === true &&
    accumulator.currentRound.invalidated === false &&
    accumulator.currentRound.hasCompleteEvidence === true
  );
}

/** Compute one ADR sample from complete, player-observed rounds. */
export function selectPlayerAdrSample(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
  includeCurrentRound: boolean,
): { readonly value: number | null; readonly rounds: number; readonly partial: boolean } {
  if (!isValidSteam64(sourcePlayerId)) return { value: null, rounds: 0, partial: true };
  let damage = 0;
  let rounds = 0;
  let partial = accumulator.coverage === 'partial';
  for (const round of accumulator.completedRounds) {
    const player = round.players[sourcePlayerId];
    if (!round.complete || player === undefined) {
      partial = true;
      continue;
    }
    damage += player.damage;
    rounds++;
  }
  const current = accumulator.currentRound;
  if (includeCurrentRound && current !== null) {
    if (currentRoundIsCounted(accumulator)) {
      const currentDamage = current.damageBySteam64[sourcePlayerId];
      if (
        currentDamage === undefined ||
        current.latestDamageBySteam64[sourcePlayerId] === undefined
      ) {
        partial = true;
      } else {
        damage += currentDamage;
        rounds++;
      }
    } else if (current.invalidated) {
      partial = true;
    }
  }
  return { value: rounds === 0 ? null : damage / rounds, rounds, partial };
}

export function getPlayerCompletedAdr(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
): number | null {
  return selectPlayerAdrSample(accumulator, sourcePlayerId, false).value;
}

export function getPlayerLiveAdr(
  accumulator: MapPlayerStatsAccumulator,
  sourcePlayerId: string,
): number | null {
  return selectPlayerAdrSample(accumulator, sourcePlayerId, true).value;
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
  if (currentRound.latestDamageBySteam64[sourcePlayerId] === undefined) return null;
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

/** Attach a sealed, adapter-verified complete event batch to one completed GSI round. */
export function reduceTrustedProgramRoundEvents(
  accumulator: MapPlayerStatsAccumulator,
  input: TrustedProgramRoundEvents,
): MapPlayerStatsAccumulator {
  if (
    input.mapEpoch !== accumulator.mapEpoch ||
    input.coverage !== 'complete' ||
    input.deaths.length > 128 ||
    input.source.role !== 'program' ||
    !Number.isSafeInteger(input.source.generation) ||
    input.source.generation < 0 ||
    !Number.isFinite(input.source.ticksPerSecond) ||
    input.source.ticksPerSecond <= 0 ||
    !Number.isSafeInteger(input.source.startTick) ||
    !Number.isSafeInteger(input.source.endTick) ||
    input.source.startTick < 0 ||
    input.source.endTick < input.source.startTick
  )
    return accumulator;
  const matches = accumulator.completedRounds.filter(
    (round) => round.roundNumberHint === input.roundNumberHint,
  );
  if (matches.length !== 1 || matches[0]!.deaths !== null) return accumulator;
  const round = matches[0]!;
  let generation: number | undefined;
  let ticksPerSecond: number | undefined;
  let lastTick = -1;
  let lastSequence = -1;
  for (const event of input.deaths) {
    const cursor = event.cursor;
    const victim = event.victim.sourcePlayerId;
    const attacker = event.attacker?.sourcePlayerId;
    const assister = event.assister?.sourcePlayerId;
    if (
      cursor.kind !== 'cs2-cstv' ||
      cursor.role !== 'program' ||
      cursor.generation !== input.source.generation ||
      cursor.ticksPerSecond !== input.source.ticksPerSecond ||
      cursor.tick < input.source.startTick ||
      cursor.tick > input.source.endTick ||
      !Number.isSafeInteger(cursor.tick) ||
      cursor.tick < lastTick ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence <= lastSequence ||
      !Number.isFinite(cursor.ticksPerSecond) ||
      cursor.ticksPerSecond! <= 0 ||
      (generation !== undefined && generation !== cursor.generation) ||
      (ticksPerSecond !== undefined && ticksPerSecond !== cursor.ticksPerSecond) ||
      victim === undefined ||
      round.players[victim] === undefined ||
      (event.attacker !== undefined &&
        (attacker === undefined || round.players[attacker] === undefined)) ||
      (event.assister !== undefined &&
        (assister === undefined || round.players[assister] === undefined))
    )
      return accumulator;
    generation = cursor.generation;
    ticksPerSecond = cursor.ticksPerSecond;
    lastTick = cursor.tick;
    lastSequence = cursor.sequence;
  }
  return {
    ...accumulator,
    completedRounds: accumulator.completedRounds.map((candidate) =>
      candidate === round ? { ...candidate, deaths: [...input.deaths] } : candidate,
    ),
  };
}
