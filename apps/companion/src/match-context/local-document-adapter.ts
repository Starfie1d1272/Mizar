import { createHash } from 'node:crypto';

import type { MatchDocumentV1 } from '@mizar/core/match-context';
import { parseMatchDocumentV1 } from '@mizar/protocol/context';
import { validateBroadcastManifest, type BroadcastManifestV1 } from '@mizar/rivalhub';

/** Compatibility view for existing BP/Runtime consumers; local storage never uses this shape. */
export function localDocumentBindingManifest(input: unknown): BroadcastManifestV1 {
  const document: MatchDocumentV1 = parseMatchDocumentV1(input);
  const toWireSide = (side: 'CT' | 'T' | null) =>
    side === null ? null : side === 'CT' ? ('ct' as const) : ('t' as const);
  const entrant = (entry: MatchDocumentV1['entrants']['a']) => ({
    entryId: entry.entryId,
    name: entry.name,
    logoUrl: entry.logoUrl,
    roster: { rosterId: entry.rosterId, players: entry.players.map((player) => ({ ...player })) },
  });
  const candidate = {
    schemaVersion: 'rivalhub.broadcast-manifest.v1',
    revision: `local:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`,
    match: {
      matchId: document.matchId,
      competition: { ...document.competition, slug: document.competition.competitionId },
      status: document.status,
      format: document.format,
      stage: document.stageLabel,
      stageKey: document.stage,
      stageLabel: document.stageLabel,
      roundLabel: document.roundLabel,
      matchLabel: document.matchLabel,
      stakesLabel: document.stakesLabel,
      mapPool: document.mapPool,
      round: document.round,
      entryRound: document.entryRound,
      scheduledAt: document.scheduledAt,
      startedAt: document.startedAt,
      completedAt: document.completedAt,
      scoreA: document.scoreA,
      scoreB: document.scoreB,
      isForfeit: document.isForfeit,
    },
    entrants: { a: entrant(document.entrants.a), b: entrant(document.entrants.b) },
    maps: document.maps.map((map) => ({ ...map, teamAStartSide: toWireSide(map.teamAStartSide) })),
    veto: document.veto.map((step) => ({ ...step, side: toWireSide(step.side) })),
    commentators: document.commentators.map((person) => ({ ...person })),
  };
  const result = validateBroadcastManifest(candidate);
  if (!result.ok) throw new Error('local_document_manifest_conversion_failed');
  return result.value;
}
