/** Fixed, source-labelled facts shared by all Program consumers. */
export type MetricSource = 'gsi' | 'program-events' | 'gsi-and-program-events';
export type MetricWindow = 'map-scoreboard' | 'current-round' | 'completed-observed-rounds' | 'completed-plus-current';
export type MetricDefinition = 'scoreboard-count.v1' | 'adr.v1' | 'kast-percent.v1' | 'impact-approx.v1' | 'rating2-approx.v1' | 'round-damage.v1' | 'round-money-spent.v1';
export type MetricReason = 'missing-input' | 'no-rounds' | 'incomplete-coverage' | 'untrusted-events' | 'invalid-input' | 'zero-denominator';
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
  readonly scoreboard: { readonly kills: MetricNumber; readonly assists: MetricNumber; readonly deaths: MetricNumber };
  readonly completed: { readonly adr: MetricNumber; readonly kastPercent: MetricNumber; readonly impactApprox: MetricNumber; readonly rating2Approx: MetricNumber };
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
  if (!Number.isSafeInteger(rounds) || rounds <= 0 || ![kills, assists, deaths, damage, kastRounds].every((x) => Number.isFinite(x) && x >= 0) || kastRounds > rounds) return null;
  const kpr = kills / rounds;
  const apr = assists / rounds;
  const dpr = deaths / rounds;
  const adr = damage / rounds;
  const kastPercent = 100 * kastRounds / rounds;
  const impactApprox = 2.13 * kpr + 0.42 * apr - 0.41;
  return { adr, kastPercent, impactApprox, rating2Approx: 0.0073 * kastPercent + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impactApprox + 0.0032 * adr + 0.1587 };
}
