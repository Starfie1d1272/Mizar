/** Resolve a completed series winner only when the score establishes it. */
export function seriesWinnerSide(
  series: {
    readonly status: 'planned' | 'live' | 'completed';
    readonly requiredWins: number;
    readonly score: { readonly a: number | null; readonly b: number | null };
  } | null,
): 'a' | 'b' | null {
  if (!series || series.status !== 'completed') return null;
  const { a, b } = series.score;
  if (a === null || b === null) return null;
  if (a >= series.requiredWins && a > b) return 'a';
  if (b >= series.requiredWins && b > a) return 'b';
  return null;
}
