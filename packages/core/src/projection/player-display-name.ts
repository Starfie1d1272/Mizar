/** Only remove a proven team name at a delimiter boundary; never guess a clan tag. */
export function observedPlayerDisplayName(
  displayName: string | null,
  teamNames: readonly (string | null | undefined)[],
): string | null {
  if (displayName === null) return null;
  const names = teamNames
    .flatMap((name) =>
      name?.trim() ? [name.trim(), `[${name.trim()}]`, `【${name.trim()}】`] : [],
    )
    .sort((left, right) => right.length - left.length);
  for (const name of names) {
    if (displayName.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    const suffix = displayName.slice(name.length);
    if (suffix.length === 0) return displayName;
    if (!/^[\s|｜:：·\-–—]/u.test(suffix)) continue;
    const nickname = suffix.replace(/^[\s|｜:：·\-–—]+/u, '').trim();
    return nickname.length > 0 ? nickname : displayName;
  }
  return displayName;
}

/** Presentation only: canonical identity and raw telemetry remain unchanged. */
export function livePlayerDisplayName(
  observedName: string | null | undefined,
  canonicalName: string | null | undefined,
  teamNames: readonly (string | null | undefined)[],
): { displayName: string | null; displayNameSource: 'observed' | 'canonical' | 'unavailable' } {
  if (observedName?.trim()) {
    return {
      displayName: observedPlayerDisplayName(observedName, teamNames),
      displayNameSource: 'observed',
    };
  }
  return {
    displayName: canonicalName ?? null,
    displayNameSource: canonicalName == null ? 'unavailable' : 'canonical',
  };
}
