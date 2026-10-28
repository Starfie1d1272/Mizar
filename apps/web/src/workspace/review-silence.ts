export const SILENCED_MATCH_KEY = 'mizar.preflight.silenced-match.v1';

export const SILENCE_CHANGED = 'mizar-review-silence-changed';

export function setSilencedMatch(matchId: string | null) {
  try {
    if (matchId) localStorage.setItem(SILENCED_MATCH_KEY, matchId);
    else localStorage.removeItem(SILENCED_MATCH_KEY);
  } catch {
    // The current window can still share the preference in memory.
  }
  window.dispatchEvent(new CustomEvent(SILENCE_CHANGED, { detail: matchId }));
}
