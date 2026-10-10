import type { MatchContext, MatchDocumentV1 } from '@mizar/core/match-context';
import { z } from 'zod';
import { structuralDiagnostics } from '../validation-helpers.js';
import { makeContractDiagnostic } from '../diagnostics.js';
import { parseMatchDocumentV1 } from '@mizar/protocol/context';

import { validateBroadcastManifest } from './validate.js';
import type { BroadcastEntrantV1, BroadcastManifest, BroadcastSide } from './types.js';

export class BroadcastManifestConversionError extends Error {
  readonly diagnostics: ReturnType<typeof validateBroadcastManifest>['diagnostics'];

  constructor(
    diagnostics: ReturnType<typeof validateBroadcastManifest>['diagnostics'],
    readonly stage: 'manifest' | 'match_document' = 'manifest',
  ) {
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
  const manifest: BroadcastManifest = result.value;
  const competition = manifest.match.competition;

  return {
    matchId: manifest.match.matchId,
    competition:
      competition === null
        ? null
        : {
            competitionId: competition.competitionId,
            slug: competition.slug,
            name: competition.name,
            themeColor: competition.themeColor,
            ...(competition.logoUrl === undefined ? {} : { logoUrl: competition.logoUrl }),
          },
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
    resultDisposition:
      manifest.match.resultDisposition ??
      (manifest.match.status === 'finished'
        ? manifest.match.scoreA !== null && manifest.match.scoreB !== null
          ? 'recorded'
          : 'pending'
        : null),
    isForfeit: manifest.match.isForfeit,
    isTest: manifest.match.isTest ?? false,
    entrants: {
      a: toEntrant(manifest.entrants.a),
      b: toEntrant(manifest.entrants.b),
    },
    mapPool: manifest.match.mapPool ?? [],
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

/** Adapt the current RivalHub read contract into Mizar's independent input document. */
export function toMatchDocumentV1(input: unknown): MatchDocumentV1 {
  const validation = validateBroadcastManifest(input);
  if (!validation.ok) throw new BroadcastManifestConversionError(validation.diagnostics);
  const manifest = validation.value;
  const context = toMatchContext(input);
  const mapNames = manifest.match.mapPool ?? [];

  try {
    return parseMatchDocumentV1({
      ...context,
      schemaVersion: 'mizar.match-document.v1',
      competition:
        context.competition === null
          ? null
          : {
              competitionId: context.competition.competitionId,
              name: context.competition.name,
              themeColor: context.competition.themeColor,
              logoUrl: context.competition.logoUrl ?? null,
            },
      stage: manifest.match.stageKey ?? context.stage,
      stageLabel: manifest.match.stageLabel ?? context.stage ?? '比赛',
      roundLabel: manifest.match.roundLabel ?? null,
      matchLabel: manifest.match.matchLabel ?? null,
      stakesLabel: manifest.match.stakesLabel ?? null,
      mapPool: [...new Set(mapNames)],
    });
  } catch (error) {
    const diagnostics =
      error instanceof z.ZodError
        ? structuralDiagnostics(error, 'MatchDocumentV1')
        : [
            makeContractDiagnostic(
              'structural',
              'error',
              'invalid_shape',
              '$',
              '比赛资料超过大小限制或不能转换。',
            ),
          ];
    throw new BroadcastManifestConversionError(diagnostics, 'match_document');
  }
}
