type ResultFacts = {
  status: string;
  format: 'bo1' | 'bo3' | 'bo5';
  scoreA: number | null;
  scoreB: number | null;
  resultDisposition?: 'recorded' | 'pending' | 'omitted' | null | undefined;
  isForfeit: boolean;
};

/** Validate a declared result without inventing unknown maps or overriding live observations. */
export function matchResultIssue(
  match: ResultFacts,
  maps: readonly { mapOrder: number; scoreA: number | null; scoreB: number | null }[],
): string | null {
  const disposition = match.resultDisposition;
  if (disposition == null) return null;
  if (match.status !== 'finished') return 'A result conclusion requires finished execution';
  if (disposition !== 'recorded')
    return match.scoreA === null && match.scoreB === null
      ? null
      : 'An unreported result cannot contain a final score';
  const a = match.scoreA,
    b = match.scoreB;
  const threshold = match.format === 'bo1' ? 1 : match.format === 'bo3' ? 2 : 3;
  if (
    a === null ||
    b === null ||
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    Math.min(a, b) < 0 ||
    Math.max(a, b) !== threshold ||
    Math.min(a, b) >= threshold
  )
    return 'Invalid confirmed series score';
  if (!match.isForfeit) {
    const scored = maps.filter((map) => map.scoreA !== null && map.scoreB !== null);
    const total = a + b;
    const known = new Map(
      scored.map((map) => [map.mapOrder, map.scoreA! > map.scoreB! ? 'a' : 'b']),
    );
    const possible = (order: number, winsA: number, winsB: number): boolean => {
      if (order > total) return winsA === a && winsB === b;
      if (winsA >= threshold || winsB >= threshold) return false;
      const winner = known.get(order);
      return (
        (winner !== 'b' && winsA < a && possible(order + 1, winsA + 1, winsB)) ||
        (winner !== 'a' && winsB < b && possible(order + 1, winsA, winsB + 1))
      );
    };
    if ([...known.keys()].some((order) => order < 1 || order > total) || !possible(1, 0, 0))
      return 'Confirmed result contradicts map order or series completion';
    if (
      scored.filter((map) => map.scoreA! > map.scoreB!).length > a ||
      scored.filter((map) => map.scoreB! > map.scoreA!).length > b
    )
      return 'Confirmed series score conflicts with known maps';
  }
  return null;
}
