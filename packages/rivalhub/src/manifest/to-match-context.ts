import type { MatchContext } from '@mizar/core/match-context';

import { validateBroadcastManifest } from './validate.js';
import type { BroadcastEntrantV1, BroadcastManifestV1, BroadcastSide } from './types.js';

export class BroadcastManifestConversionError extends Error {
  readonly diagnostics: ReturnType<typeof validateBroadcastManifest>['diagnostics'];

  constructor(diagnostics: ReturnType<typeof validateBroadcastManifest>['diagnostics']) {
    super('BroadcastManifest 不能转换为 MatchContext。');
    this.name = 'BroadcastManifestConversionError';
    this.diagnostics = diagnostics;
  }
}

function toCoreSide(side: BroadcastSide | null): 'CT' | 'T' | null {
  if (side === null) return null;
  return side === 'ct' ? 'CT' : 'T';
}

function toEntrant(entrant: BroadcastEntrantV1) {
  return {
    entryId: entrant.entryId,
    name: entrant.name,
    logoUrl: entrant.logoUrl,
    rosterId: entrant.roster.rosterId,
    players: entrant.roster.players.map((player) => ({
      playerId: player.playerId,
      steam64: player.steam64,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
      isStarter: player.isStarter,
    })),
  } as const;
}

export function toMatchContext(input: unknown): MatchContext {
  const result = validateBroadcastManifest(input);
  if (!result.ok) throw new BroadcastManifestConversionError(result.diagnostics);
  const manifest: BroadcastManifestV1 = result.value;

  return {
    matchId: manifest.match.matchId,
    competition: { ...manifest.match.competition },
    status: manifest.match.status,
    format: manifest.match.format,
    stage: manifest.match.stage,
    round: manifest.match.round,
    entryRound: manifest.match.entryRound,
    scheduledAt: manifest.match.scheduledAt,
    startedAt: manifest.match.startedAt,
    completedAt: manifest.match.completedAt,
    scoreA: manifest.match.scoreA,
    scoreB: manifest.match.scoreB,
    isForfeit: manifest.match.isForfeit,
    entrants: {
      a: toEntrant(manifest.entrants.a),
      b: toEntrant(manifest.entrants.b),
    },
    maps: [...manifest.maps]
      .sort(
        (left, right) => left.mapOrder - right.mapOrder || left.mapId.localeCompare(right.mapId),
      )
      .map((map) => ({
        mapId: map.mapId,
        mapOrder: map.mapOrder,
        mapName: map.mapName,
        pickedByEntryId: map.pickedByEntryId,
        teamAStartSide: toCoreSide(map.teamAStartSide),
        scoreA: map.scoreA,
        scoreB: map.scoreB,
        completedAt: map.completedAt,
      })),
    veto: [...manifest.veto]
      .sort(
        (left, right) =>
          left.stepOrder - right.stepOrder || left.mapName.localeCompare(right.mapName),
      )
      .map((step) => ({
        stepOrder: step.stepOrder,
        actionType: step.actionType,
        mapName: step.mapName,
        entryId: step.entryId,
        side: toCoreSide(step.side),
      })),
    commentators: manifest.commentators.map((commentator) => ({ ...commentator })),
  };
}
