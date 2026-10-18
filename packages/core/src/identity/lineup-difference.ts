import type { IdentityResolution } from './types.js';

/** Current account proof for both entrants; names never establish ownership. */
export function hasObservedLineupDifference(identity: IdentityResolution): boolean {
  if (
    !['matched', 'degraded'].includes(identity.state) ||
    !identity.capabilities.canonicalTeamBranding ||
    !identity.issues.some((issue) =>
      ['unexpected_human_steam64', 'lineup_differs_from_expected'].includes(issue.code),
    )
  )
    return false;
  if (
    identity.issues.some(
      (issue) =>
        ![
          'unexpected_human_steam64',
          'lineup_differs_from_expected',
          'missing_canonical_display_name',
        ].includes(issue.code) &&
        !(issue.code === 'missing_canonical_steam64' && issue.affectsExpectedLineup === false) &&
        !(
          issue.severity === 'info' &&
          ['map_epoch_changed', 'source_generation_changed'].includes(issue.code)
        ),
    )
  )
    return false;
  const players = [
    ...identity.players.filter((p) => p.evidence === 'current'),
    ...identity.unresolved,
  ];
  return (
    players.length === 10 &&
    players.every((p) => p.sourcePlayerId !== null && /^\d{17}$/.test(p.sourcePlayerId)) &&
    new Set(players.map((p) => p.sourcePlayerId)).size === 10 &&
    players.filter((p) => p.side === 'CT').length === 5 &&
    players.filter((p) => p.side === 'T').length === 5 &&
    new Set(identity.players.filter((p) => p.evidence === 'current').map((p) => p.entryId)).size ===
      2
  );
}
