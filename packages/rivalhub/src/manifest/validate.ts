import {
  hasBlockingDiagnostic,
  makeContractDiagnostic,
  validationFailure,
  validationSuccess,
  type ContractDiagnostic,
  type ContractValidationResult,
} from '../diagnostics.js';
import {
  addSemanticDiagnostic,
  nonEmpty,
  scorePair,
  structuralDiagnostics,
  timestamp,
} from '../validation-helpers.js';
import { broadcastManifestSchema } from './schema.js';
import {
  BROADCAST_MANIFEST_SCHEMA_VERSION,
  type BroadcastManifest,
  type BroadcastPlayerV1,
} from './types.js';

const STEAM64_PATTERN = /^\d{17}$/;

function maximumMapCount(format: BroadcastManifest['match']['format']): number {
  return format === 'bo1' ? 1 : format === 'bo3' ? 3 : 5;
}

function hasUnsupportedSchemaVersion(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    'schemaVersion' in input &&
    input.schemaVersion !== BROADCAST_MANIFEST_SCHEMA_VERSION &&
    input.schemaVersion !== 'rivalhub.broadcast-manifest.v2'
  );
}

function validatePlayer(
  player: BroadcastPlayerV1,
  path: string,
  playerIds: Map<string, string>,
  steam64s: Map<string, string>,
  diagnostics: ContractDiagnostic[],
): void {
  nonEmpty(player.playerId, `${path}.playerId`, diagnostics, 'playerId');
  const playerPath = `${path}.playerId`;
  const previousPlayer = playerIds.get(player.playerId);
  if (previousPlayer !== undefined) {
    addSemanticDiagnostic(
      diagnostics,
      'duplicate_player_id',
      'error',
      playerPath,
      'Manifest 内 playerId 必须全局唯一。',
    );
  } else {
    playerIds.set(player.playerId, playerPath);
  }

  if (player.steam64 === null || player.steam64.trim().length === 0) {
    addSemanticDiagnostic(
      diagnostics,
      'missing_steam64',
      'warning',
      `${path}.steam64`,
      'canonical player 缺少 Steam64。',
    );
  } else if (!STEAM64_PATTERN.test(player.steam64)) {
    addSemanticDiagnostic(
      diagnostics,
      'invalid_steam64',
      'error',
      `${path}.steam64`,
      'Steam64 必须保持为 17 位数字字符串。',
    );
  } else {
    const previousSteam = steam64s.get(player.steam64);
    if (previousSteam !== undefined) {
      addSemanticDiagnostic(
        diagnostics,
        'duplicate_steam64',
        'error',
        `${path}.steam64`,
        '非空 canonical Steam64 必须全局唯一。',
      );
    } else {
      steam64s.set(player.steam64, `${path}.steam64`);
    }
  }

  if (player.displayName === null || player.displayName.trim().length === 0) {
    addSemanticDiagnostic(
      diagnostics,
      'missing_display_name',
      'warning',
      `${path}.displayName`,
      'canonical player 缺少 RivalHub displayName。',
    );
  }
}

function validateManifestSemantics(value: BroadcastManifest): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  nonEmpty(value.revision, 'revision', diagnostics, 'revision');
  nonEmpty(value.match.matchId, 'match.matchId', diagnostics, 'matchId');
  if (value.match.competition !== null) {
    nonEmpty(
      value.match.competition.competitionId,
      'match.competition.competitionId',
      diagnostics,
      'competitionId',
    );
    nonEmpty(
      value.match.competition.slug,
      'match.competition.slug',
      diagnostics,
      'competition slug',
    );
    nonEmpty(
      value.match.competition.name,
      'match.competition.name',
      diagnostics,
      'competition name',
    );
  }
  if (value.match.stage !== null) nonEmpty(value.match.stage, 'match.stage', diagnostics, 'stage');

  const entryIds = [value.entrants.a.entryId, value.entrants.b.entryId];
  nonEmpty(value.entrants.a.entryId, 'entrants.a.entryId', diagnostics, 'entryId');
  nonEmpty(value.entrants.b.entryId, 'entrants.b.entryId', diagnostics, 'entryId');
  nonEmpty(value.entrants.a.name, 'entrants.a.name', diagnostics, 'entrant name');
  nonEmpty(value.entrants.b.name, 'entrants.b.name', diagnostics, 'entrant name');
  if (entryIds[0] === entryIds[1]) {
    addSemanticDiagnostic(
      diagnostics,
      'duplicate_entry_id',
      'error',
      'entrants',
      'A/B entryId 不得相同。',
    );
  }

  timestamp(value.match.scheduledAt, 'match.scheduledAt', diagnostics);
  timestamp(value.match.startedAt, 'match.startedAt', diagnostics);
  timestamp(value.match.completedAt, 'match.completedAt', diagnostics);
  if (
    value.match.round !== null &&
    (!Number.isSafeInteger(value.match.round) || value.match.round < 1)
  ) {
    addSemanticDiagnostic(
      diagnostics,
      'invalid_round',
      'error',
      'match.round',
      'round 必须是从 1 开始的安全整数或 null。',
    );
  }
  scorePair(value.match.scoreA, value.match.scoreB, 'match.score', diagnostics);

  const playerIds = new Map<string, string>();
  const steam64s = new Map<string, string>();
  for (const [entrantKey, entrant] of [
    ['a', value.entrants.a],
    ['b', value.entrants.b],
  ] as const) {
    const playersPath = `entrants.${entrantKey}.roster.players`;
    if (entrant.roster.players.length < 5) {
      addSemanticDiagnostic(
        diagnostics,
        'incomplete_roster',
        'warning',
        playersPath,
        'roster 少于五名选手，标记为 partial evidence。',
      );
    }
    for (const [index, player] of entrant.roster.players.entries()) {
      validatePlayer(player, `${playersPath}.${index}`, playerIds, steam64s, diagnostics);
    }
  }

  const knownEntryIds = new Set(entryIds);
  const mapOrders = new Set<number>();
  const mapIds = new Set<string>();
  const maximumMaps = maximumMapCount(value.match.format);
  if (value.maps.length > maximumMaps) {
    addSemanticDiagnostic(
      diagnostics,
      'invalid_map_count',
      'error',
      'maps',
      `${value.match.format} 的 canonical map list 不得超过 ${maximumMaps} 张地图。`,
    );
  }
  for (const [index, map] of value.maps.entries()) {
    const path = `maps.${index}`;
    nonEmpty(map.mapId, `${path}.mapId`, diagnostics, 'mapId');
    nonEmpty(map.mapName, `${path}.mapName`, diagnostics, 'mapName');
    if (!Number.isSafeInteger(map.mapOrder) || map.mapOrder < 1 || map.mapOrder > maximumMaps) {
      addSemanticDiagnostic(
        diagnostics,
        'invalid_map_order',
        'error',
        `${path}.mapOrder`,
        `mapOrder 必须是 1 到 ${maximumMaps} 之间的安全整数。`,
      );
    }
    if (mapOrders.has(map.mapOrder)) {
      addSemanticDiagnostic(
        diagnostics,
        'duplicate_map_order',
        'error',
        `${path}.mapOrder`,
        'mapOrder 必须唯一。',
      );
    }
    mapOrders.add(map.mapOrder);
    if (mapIds.has(map.mapId)) {
      addSemanticDiagnostic(
        diagnostics,
        'duplicate_map_id',
        'error',
        `${path}.mapId`,
        'mapId 必须唯一。',
      );
    }
    mapIds.add(map.mapId);
    if (map.pickedByEntryId !== null && !knownEntryIds.has(map.pickedByEntryId)) {
      addSemanticDiagnostic(
        diagnostics,
        'unknown_entry_reference',
        'error',
        `${path}.pickedByEntryId`,
        'pickedByEntryId 必须指向 A/B entry。',
      );
    }
    timestamp(map.completedAt, `${path}.completedAt`, diagnostics);
    scorePair(map.scoreA, map.scoreB, `${path}.score`, diagnostics);
  }

  const vetoOrders = new Set<number>();
  for (const [index, step] of value.veto.entries()) {
    const path = `veto.${index}`;
    nonEmpty(step.actionType, `${path}.actionType`, diagnostics, 'actionType');
    nonEmpty(step.mapName, `${path}.mapName`, diagnostics, 'mapName');
    if (!Number.isSafeInteger(step.stepOrder) || step.stepOrder < 1) {
      addSemanticDiagnostic(
        diagnostics,
        'invalid_veto_step_order',
        'error',
        `${path}.stepOrder`,
        'stepOrder 必须是从 1 开始的安全整数。',
      );
    }
    if (vetoOrders.has(step.stepOrder)) {
      addSemanticDiagnostic(
        diagnostics,
        'duplicate_veto_step_order',
        'error',
        `${path}.stepOrder`,
        'veto stepOrder 必须唯一。',
      );
    }
    vetoOrders.add(step.stepOrder);
    if (step.entryId !== null && !knownEntryIds.has(step.entryId)) {
      addSemanticDiagnostic(
        diagnostics,
        'unknown_entry_reference',
        'error',
        `${path}.entryId`,
        'veto entryId 必须指向 A/B entry。',
      );
    }
  }

  for (const [index, commentator] of value.commentators.entries()) {
    const path = `commentators.${index}`;
    nonEmpty(commentator.userId, `${path}.userId`, diagnostics, 'userId');
    nonEmpty(
      commentator.displayName,
      `${path}.displayName`,
      diagnostics,
      'commentator displayName',
    );
  }

  return diagnostics;
}

export function validateBroadcastManifest(
  input: unknown,
): ContractValidationResult<BroadcastManifest> {
  if (hasUnsupportedSchemaVersion(input)) {
    return validationFailure([
      makeContractDiagnostic(
        'structural',
        'error',
        'unsupported_schema_version',
        'schemaVersion',
        '不支持的 BroadcastManifest schemaVersion。',
      ),
    ]);
  }
  const parsed = broadcastManifestSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(structuralDiagnostics(parsed.error, 'BroadcastManifest'));
  }

  const value = parsed.data;
  const diagnostics = validateManifestSemantics(value);
  return hasBlockingDiagnostic(diagnostics)
    ? validationFailure(diagnostics)
    : validationSuccess(value, diagnostics);
}
