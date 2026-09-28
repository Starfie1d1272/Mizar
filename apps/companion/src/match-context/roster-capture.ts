import { createHash, randomUUID } from 'node:crypto';
import type { MatchDocumentV1 } from '@mizar/core/match-context';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { LocalTeamV1 } from './local-tournament-store.js';

type Evidence = NonNullable<ReturnType<ProjectionCoordinator['getRosterEvidence']>>;
type Players = MatchDocumentV1['entrants']['a']['players'];

export function rosterCandidate(
  evidence: Evidence | null,
  document: MatchDocumentV1 | null,
  contextRevision: string,
  teams: readonly LocalTeamV1[] = [],
) {
  if (!evidence) return null;
  let ctEntrant: 'a' | 'b' | null = null;
  if (document) {
    const proves = (side: 'a' | 'b', players: Evidence['ct']) =>
      players.every((player) =>
        document.entrants[side].players.some((item) => item.steam64 === player.steam64),
      );
    const aIsCt = proves('a', evidence.ct) && proves('b', evidence.t);
    const bIsCt = proves('b', evidence.ct) && proves('a', evidence.t);
    if (aIsCt !== bIsCt) ctEntrant = aIsCt ? 'a' : 'b';
    else if (!aIsCt && document.entrants.a.name !== document.entrants.b.name) {
      if (
        evidence.ctName === document.entrants.a.name &&
        evidence.tName === document.entrants.b.name
      )
        ctEntrant = 'a';
      else if (
        evidence.ctName === document.entrants.b.name &&
        evidence.tName === document.entrants.a.name
      )
        ctEntrant = 'b';
    }
  }
  const matchingTeams = (players: Evidence['ct'], name: string | null) =>
    teams.filter(
      (team) =>
        (name !== null && team.name === name) ||
        players.every((player) => team.players.some((known) => known.steam64 === player.steam64)),
    );
  const ctTeams = matchingTeams(evidence.ct, evidence.ctName);
  const tTeams = matchingTeams(evidence.t, evidence.tName);
  // Stable while membership, names and continuity remain the same; never one token per frame.
  const revision = createHash('sha256')
    .update(JSON.stringify({ evidence, contextRevision, ctTeams, tTeams }))
    .digest('hex');
  const summary = (team: LocalTeamV1) => ({ teamId: team.teamId, name: team.name });
  return {
    ...evidence,
    contextRevision,
    revision,
    ctEntrant,
    teamOptions: { ct: ctTeams.map(summary), t: tTeams.map(summary) },
  };
}

export function mergeObservedStarters(existing: Players, observed: Evidence['ct']): Players {
  const ids = new Set(observed.map((player) => player.steam64));
  return [
    ...existing.map((player) => ({
      ...player,
      isStarter: player.steam64 !== null && ids.has(player.steam64),
    })),
    ...observed
      .filter((player) => !existing.some((item) => item.steam64 === player.steam64))
      .map((player) => ({
        playerId: randomUUID(),
        steam64: player.steam64,
        displayName: player.displayName,
        avatarUrl: null,
        isStarter: true,
      })),
  ];
}
