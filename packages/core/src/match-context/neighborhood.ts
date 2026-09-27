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
  const matches = window.matches;
  const index = matches.findIndex((match) => match.matchId === matchId);
  if (index < 0) return { previous: null, current: null, next: null, upcoming: [] };
  return {
    previous: matches[index - 1] ?? null,
    current: matches[index] ?? null,
    next: matches[index + 1] ?? null,
    upcoming: matches.slice(index + 1),
  };
}
