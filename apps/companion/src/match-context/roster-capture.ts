import { createHash, randomUUID } from 'node:crypto';
import type { MatchDocumentV1 } from '@mizar/core/match-context';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';

type Evidence = NonNullable<ReturnType<ProjectionCoordinator['getRosterEvidence']>>;
type Players = MatchDocumentV1['entrants']['a']['players'];

export function rosterCandidate(
  evidence: Evidence | null,
  document: MatchDocumentV1 | null,
  contextRevision: string,
) {
  if (!evidence) return null;
  let ctEntrant: 'a' | 'b' | null = null;
  if (document) {
    const proves = (side: 'a' | 'b', players: Evidence['ct']) =>
      players.every((player) =>
        document.entrants[side].players.some((item) => item.steam64 === player.steam64),
      );
    if (proves('a', evidence.ct) && proves('b', evidence.t)) ctEntrant = 'a';
    else if (proves('b', evidence.ct) && proves('a', evidence.t)) ctEntrant = 'b';
    else if (document.entrants.a.name !== document.entrants.b.name) {
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
  // Stable while membership, names and continuity remain the same; never one token per frame.
  const revision = createHash('sha256')
    .update(JSON.stringify({ evidence, contextRevision }))
    .digest('hex');
  return { ...evidence, contextRevision, revision, ctEntrant };
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
