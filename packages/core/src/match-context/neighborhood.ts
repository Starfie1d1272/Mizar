import type { ScheduleMatchContext, ScheduleWindow } from './types.js';

export interface ScheduleNeighborhood {
  readonly previous: ScheduleMatchContext | null;
  readonly current: ScheduleMatchContext | null;
  readonly next: ScheduleMatchContext | null;
  readonly upcoming: readonly ScheduleMatchContext[];
}

/** The acquisition owner supplies stable schedule order; do not infer it from a missing time. */
export function deriveScheduleNeighborhood(
  window: ScheduleWindow | null,
  matchId: string,
): ScheduleNeighborhood {
  if (window === null) return { previous: null, current: null, next: null, upcoming: [] };
  const selected = window.matches.find((match) => match.matchId === matchId);
  // Test matches are individually rehearsed; neither official nor other test
  // matches become automatic adjacent-program destinations.
  const matches = selected?.isTest ? [selected] : window.matches.filter((match) => !match.isTest);
  const index = matches.findIndex((match) => match.matchId === matchId);
  if (index < 0) return { previous: null, current: null, next: null, upcoming: [] };
  return {
    previous: matches[index - 1] ?? null,
    current: matches[index] ?? null,
    next: matches[index + 1] ?? null,
    upcoming: matches.slice(index + 1),
  };
}
