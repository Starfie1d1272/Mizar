import { canonicalizeCs2MapName } from '@mizar/core/map-name';
import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';

/** Display-only exception. A known account on each side proves the two entrants;
 * unresolved accounts remain observed identities, never guessed canonical players.
 */
export function hasLineupMismatchOnly(
  bundle: Pick<ProjectionBundle, 'program' | 'operator'>,
  binding: MatchContextBinding | undefined,
): boolean {
  const { program, operator } = bundle;
  const identity = operator.identity;
  if (
    !binding ||
    binding.origin !== 'online' ||
    binding.freshness !== 'fresh' ||
    program.match?.matchId !== binding.context.matchId ||
    program.status.context !== 'fresh' ||
    program.status.telemetry !== 'fresh' ||
    !['matched', 'degraded'].includes(identity.state) ||
    !identity.capabilities.canonicalTeamBranding ||
    operator.activeLineup.state !== 'complete' ||
    operator.activeLineup.retainedCount !== 0 ||
    operator.activeLineup.sourceGeneration !== program.cursor.programSourceGeneration ||
    operator.activeLineup.mapEpoch !== program.cursor.mapEpoch ||
    operator.runtime.lastAccepted?.receiveSequence !== program.cursor.programReceiveSequence ||
    !program.cursor.liveSessionId ||
    program.series?.bindingState !== 'bound'
  )
    return false;
  const currentMap = program.series.maps.find(
    (map) => map.mapOrder === program.series?.currentMapOrder,
  );
  const expectedMap = binding.context.maps.find((map) => map.mapOrder === currentMap?.mapOrder);
  if (
    !currentMap ||
    !expectedMap ||
    currentMap.status !== 'current' ||
    currentMap.mapId !== expectedMap.mapId ||
    program.map.name === null ||
    canonicalizeCs2MapName(expectedMap.mapName) !== canonicalizeCs2MapName(program.map.name) ||
    canonicalizeCs2MapName(currentMap.mapName) !== canonicalizeCs2MapName(program.map.name)
  )
    return false;
  const { a, b } = identity.sideMapping;
  if (a === 'unknown' || b === 'unknown' || a === b) return false;
  const teamA = a === 'CT' ? program.teams.ct : program.teams.t;
  const teamB = b === 'CT' ? program.teams.ct : program.teams.t;
  if (
    teamA.mode !== 'canonical' ||
    teamB.mode !== 'canonical' ||
    teamA.entryId !== binding.context.entrants.a.entryId ||
    teamB.entryId !== binding.context.entrants.b.entryId
  )
    return false;
  if (
    !identity.issues.some(
      (issue) =>
        issue.code === 'unexpected_human_steam64' || issue.code === 'lineup_differs_from_expected',
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
  const starters = Object.values(binding.context.entrants).flatMap((team) =>
    team.players.filter((p) => p.isStarter),
  );
  if (
    Object.values(binding.context.entrants).some(
      (team) => team.players.filter((p) => p.isStarter).length !== 5,
    ) ||
    starters.some((p) => !p.steam64 || !/^\d{17}$/.test(p.steam64)) ||
    new Set(starters.map((p) => p.steam64)).size !== 10
  )
    return false;
  const players = program.players.filter((p) => p.lineupEvidence === 'current');
  return (
    players.length === 10 &&
    new Set(players.map((p) => p.sourcePlayerId)).size === 10 &&
    players.every((p) => /^\d{17}$/.test(p.sourcePlayerId)) &&
    players.filter((p) => p.side === 'CT').length === 5 &&
    players.filter((p) => p.side === 'T').length === 5
  );
}
