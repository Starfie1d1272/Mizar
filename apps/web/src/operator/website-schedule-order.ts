type MatchOrderFields = {
  matchId: string;
  scheduledAt: string | null;
  status?: string;
  completedAt?: string | null;
};

function timestamp(value: string | null | undefined): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function group(match: MatchOrderFields): number {
  if (match.status === 'finished' || match.status === 'cancelled') return 2;
  return match.status === 'in_progress' ? 0 : 1;
}

/** Website status owns completion; old caches without status remain unfinished. */
export function sortWebsiteMatches<T extends MatchOrderFields>(matches: readonly T[]): T[] {
  return [...matches].sort((a, b) => {
    const groupDifference = group(a) - group(b);
    if (groupDifference) return groupDifference;
    const ended = group(a) === 2;
    const aTime = (ended ? timestamp(a.completedAt) : null) ?? timestamp(a.scheduledAt);
    const bTime = (ended ? timestamp(b.completedAt) : null) ?? timestamp(b.scheduledAt);
    if (aTime === null && bTime !== null) return 1;
    if (aTime !== null && bTime === null) return -1;
    if (aTime !== null && bTime !== null && aTime !== bTime) {
      return ended ? bTime - aTime : aTime - bTime;
    }
    return a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0;
  });
}
