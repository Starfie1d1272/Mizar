import type { ObservedMatchStats } from '../telemetry/index.js';
import {
  getPlayerCurrentRoundDamage,
  getPlayerCurrentRoundMoneySpent,
  selectPlayerAdrSample,
  type MapPlayerStatsAccumulator,
} from './player-stats.js';

/** Fixed, source-labelled facts shared by all Program consumers. */
export type MetricSource = 'gsi' | 'program-events' | 'gsi-and-program-events';
export type MetricWindow =
  'map-scoreboard' | 'current-round' | 'completed-observed-rounds' | 'completed-plus-current';
export type MetricDefinition =
  | 'scoreboard-count.v1'
  | 'kd-ratio.v1'
  | 'adr.v1'
  | 'kast-percent.v1'
  | 'impact-approx.v1'
  | 'rating2-approx.v1'
  | 'round-damage.v1'
  | 'round-money-spent.v1';
export type MetricReason =
  | 'missing-input'
  | 'no-rounds'
  | 'incomplete-coverage'
  | 'untrusted-events'
  | 'invalid-input'
  | 'zero-denominator';
export interface MetricNumber {
  readonly value: number | null;
  readonly basis: {
    readonly source: MetricSource;
    readonly window: MetricWindow;
    readonly definition: MetricDefinition;
    readonly rounds: number | null;
    readonly coverage: 'complete' | 'partial' | 'unavailable';
  };
  readonly reason: MetricReason | null;
}
export interface PlayerStatistics {
  readonly scoreboard: {
    readonly kills: MetricNumber;
    readonly assists: MetricNumber;
    readonly deaths: MetricNumber;
    readonly kdRatio: MetricNumber;
  };
  readonly completed: {
    readonly adr: MetricNumber;
    readonly kastPercent: MetricNumber;
    readonly impactApprox: MetricNumber;
    readonly rating2Approx: MetricNumber;
  };
  readonly includingCurrentRound: { readonly adr: MetricNumber };
  readonly currentRound: { readonly damage: MetricNumber; readonly moneySpent: MetricNumber };
}

/** All fields must describe exactly the same complete round sample. */
export interface Rating2Sample {
  readonly rounds: number;
  readonly kills: number;
  readonly assists: number;
  readonly deaths: number;
  readonly damage: number;
  readonly kastRounds: number;
}
export interface Rating2Approximation {
  readonly adr: number;
  readonly kastPercent: number;
  readonly impactApprox: number;
  readonly rating2Approx: number;
}

/**
 * Community approximation adapted from Awpy 2.0.2 (MIT),
 * https://pypi.org/project/awpy/2.0.2/ and
 * https://dave.xn--tckwe/posts/reverse-engineering-hltv-rating/.
 * Awpy source distribution SHA-256: 815736c279bd9b449646d1424c82eedc6203545115c5e21db65fc33de23c2176.
 */
export function calculateRating2Approx(sample: Rating2Sample): Rating2Approximation | null {
  const { rounds, kills, assists, deaths, damage, kastRounds } = sample;
  if (
    !Number.isSafeInteger(rounds) ||
    rounds <= 0 ||
    ![kills, assists, deaths, kastRounds].every((x) => Number.isSafeInteger(x) && x >= 0) ||
    !Number.isFinite(damage) ||
    damage < 0 ||
    deaths > rounds ||
    kastRounds > rounds
  )
    return null;
  const kpr = kills / rounds;
  const apr = assists / rounds;
  const dpr = deaths / rounds;
  const adr = damage / rounds;
  const kastPercent = (100 * kastRounds) / rounds;
  const impactApprox = 2.13 * kpr + 0.42 * apr - 0.41;
  return {
    adr,
    kastPercent,
    impactApprox,
    rating2Approx:
      0.0073 * kastPercent +
      0.3591 * kpr -
      0.5329 * dpr +
      0.2372 * impactApprox +
      0.0032 * adr +
      0.1587,
  };
}

function metric(
  value: number | null,
  source: MetricSource,
  window: MetricWindow,
  definition: MetricDefinition,
  rounds: number | null,
  reason: MetricReason = 'missing-input',
  partial = false,
): MetricNumber {
  return {
    value,
    basis: {
      source,
      window,
      definition,
      rounds,
      coverage: value === null ? 'unavailable' : partial ? 'partial' : 'complete',
    },
    reason: value === null ? reason : null,
  };
}

/** Project statistics once; legacy fields must be taken from this result. */
export function projectPlayerStatistics(
  accumulator: MapPlayerStatsAccumulator,
  playerId: string,
  scoreboard: ObservedMatchStats | undefined,
  currentMoney: number | null | undefined,
): PlayerStatistics {
  const count = (value: number | undefined) =>
    metric(
      value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null,
      'gsi',
      'map-scoreboard',
      'scoreboard-count.v1',
      null,
    );
  const killsCount = count(scoreboard?.kills);
  const assistsCount = count(scoreboard?.assists);
  const deathsCount = count(scoreboard?.deaths);
  const kdRatio = metric(
    killsCount.value !== null && deathsCount.value !== null && deathsCount.value > 0
      ? killsCount.value / deathsCount.value
      : null,
    'gsi',
    'map-scoreboard',
    'kd-ratio.v1',
    null,
    deathsCount.value === 0 ? 'zero-denominator' : 'missing-input',
  );
  const rounds = accumulator.countedCompletedRounds;
  const completedAdr = selectPlayerAdrSample(accumulator, playerId, false);
  const liveAdr = selectPlayerAdrSample(accumulator, playerId, true);
  const validRounds = accumulator.completedRounds.filter((round) => {
    if (!round.complete || round.deaths === null || round.players[playerId] === undefined)
      return false;
    const victims = round.deaths.map((event) => event.victim.sourcePlayerId);
    return (
      new Set(victims).size === victims.length &&
      Object.entries(round.players).every(([id, p]) => p.survived !== victims.includes(id))
    );
  });
  let kills = 0,
    assists = 0,
    deaths = 0,
    damage = 0,
    kastRounds = 0;
  for (const round of validRounds) {
    const player = round.players[playerId]!;
    damage += player.damage;
    let qualified = player.survived;
    const events = round.deaths!;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const victimId = event.victim.sourcePlayerId!;
      const attackerId = event.attacker?.sourcePlayerId;
      const assisterId = event.assister?.sourcePlayerId;
      const opponentKill =
        attackerId !== undefined &&
        attackerId !== victimId &&
        round.players[attackerId]!.side !== round.players[victimId]!.side;
      if (victimId === playerId) {
        deaths++;
        if (
          opponentKill &&
          events
            .slice(i + 1)
            .some(
              (reply) =>
                reply.victim.sourcePlayerId === attackerId &&
                reply.attacker?.sourcePlayerId !== undefined &&
                round.players[reply.attacker.sourcePlayerId]!.side === player.side &&
                reply.cursor.tick - event.cursor.tick <= 3 * event.cursor.ticksPerSecond!,
            )
        )
          qualified = true;
      }
      if (opponentKill && attackerId === playerId) {
        kills++;
        qualified = true;
      }
      if (
        opponentKill &&
        assisterId === playerId &&
        assisterId !== attackerId &&
        round.players[assisterId]!.side === player.side
      ) {
        assists++;
        qualified = true;
      }
    }
    if (qualified) kastRounds++;
  }
  const approximation = calculateRating2Approx({
    rounds: validRounds.length,
    kills,
    assists,
    deaths,
    damage,
    kastRounds,
  });
  const derived = (value: number | undefined, definition: MetricDefinition) =>
    metric(
      value ?? null,
      'gsi-and-program-events',
      'completed-observed-rounds',
      definition,
      validRounds.length,
      rounds === 0 ? 'no-rounds' : 'untrusted-events',
      validRounds.length < rounds || accumulator.coverage === 'partial',
    );
  return {
    scoreboard: {
      kills: killsCount,
      assists: assistsCount,
      deaths: deathsCount,
      kdRatio,
    },
    completed: {
      adr: metric(
        completedAdr.value,
        'gsi',
        'completed-observed-rounds',
        'adr.v1',
        completedAdr.rounds,
        rounds === 0 ? 'no-rounds' : 'missing-input',
        completedAdr.partial,
      ),
      kastPercent: derived(approximation?.kastPercent, 'kast-percent.v1'),
      impactApprox: derived(approximation?.impactApprox, 'impact-approx.v1'),
      rating2Approx: derived(approximation?.rating2Approx, 'rating2-approx.v1'),
    },
    includingCurrentRound: {
      adr: metric(
        liveAdr.value,
        'gsi',
        'completed-plus-current',
        'adr.v1',
        liveAdr.rounds,
        rounds === 0 && accumulator.currentRound === null ? 'no-rounds' : 'missing-input',
        liveAdr.partial,
      ),
    },
    currentRound: {
      damage: metric(
        getPlayerCurrentRoundDamage(accumulator, playerId),
        'gsi',
        'current-round',
        'round-damage.v1',
        null,
      ),
      moneySpent: metric(
        getPlayerCurrentRoundMoneySpent(accumulator, playerId, currentMoney),
        'gsi',
        'current-round',
        'round-money-spent.v1',
        null,
      ),
    },
  };
}
