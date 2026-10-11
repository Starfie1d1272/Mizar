import type { MatchContext } from '../match-context/index.js';
import type { ObservedPlayer } from '../telemetry/index.js';
import { buildCanonicalIndex, type CanonicalIndex } from './canonical-index.js';
import { normalizeIdentityEvidence, type NormalizedIdentityEvidence } from './evidence.js';
import { deriveSideMapping } from './side-mapping.js';
import type {
  IdentityIssue,
  IdentityResolution,
  IdentityObservationInput,
  IdentitySideMapping,
  IdentityState,
  ResolvedIdentityPlayer,
  UnresolvedObservedPlayer,
} from './types.js';

const STEAM64_PATTERN = /^\d{17}$/;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  code: IdentityIssue['code'],
  severity: IdentityIssue['severity'],
  message: string,
  details: Omit<IdentityIssue, 'code' | 'severity' | 'message'> = {},
): IdentityIssue {
  return { code, severity, message, ...details };
}

function sideMappingUnknown(): IdentitySideMapping {
  return { a: 'unknown', b: 'unknown' };
}

function capabilitiesFor(
  state: IdentityState,
  players: readonly ResolvedIdentityPlayer[],
  sideMapping: IdentitySideMapping,
): IdentityResolution['capabilities'] {
  const hasCompleteSideMapping =
    sideMapping.a !== 'unknown' && sideMapping.b !== 'unknown' && sideMapping.a !== sideMapping.b;
  const hasObservedProofForBothEntries =
    new Set(players.map((player) => player.entryId)).size === 2;
  return {
    canonicalPlayerMapping: state !== 'mismatch' && players.length > 0,
    // A soft roster mismatch may leave one live player unresolved while the
    // remaining Steam64/side evidence still proves which entrant is CT/T.
    canonicalTeamBranding:
      state === 'matched' ||
      (state === 'degraded' && hasCompleteSideMapping && hasObservedProofForBothEntries),
    identityDependentResult: state === 'matched',
    neutralTelemetry: true,
  };
}

function createResolution(
  state: IdentityState,
  evidence: Pick<NormalizedIdentityEvidence, 'sourceGeneration' | 'mapEpoch'>,
  players: readonly ResolvedIdentityPlayer[],
  unresolved: readonly UnresolvedObservedPlayer[],
  sideMapping: IdentitySideMapping,
  issues: readonly IdentityIssue[],
): IdentityResolution {
  return {
    state,
    sourceGeneration: evidence.sourceGeneration,
    mapEpoch: evidence.mapEpoch,
    players,
    unresolved,
    sideMapping,
    issues,
    capabilities: capabilitiesFor(state, players, sideMapping),
  };
}

function sortResolvedPlayers(players: Iterable<ResolvedIdentityPlayer>): ResolvedIdentityPlayer[] {
  return [...players].sort((left, right) => {
    const entryResult = compareStrings(left.entryId, right.entryId);
    return entryResult !== 0
      ? entryResult
      : compareStrings(left.canonicalPlayerId, right.canonicalPlayerId);
  });
}

function sortUnresolved(players: Iterable<UnresolvedObservedPlayer>): UnresolvedObservedPlayer[] {
  return [...players].sort((left, right) =>
    compareStrings(left.sourcePlayerId, right.sourcePlayerId),
  );
}

function maximumMapCount(format: MatchContext['format']): number {
  return format === 'bo1' ? 1 : format === 'bo3' ? 3 : 5;
}

function hasCompleteCanonicalMapSet(context: MatchContext): boolean {
  const expectedCount = maximumMapCount(context.format);
  if (context.maps.length !== expectedCount) return false;

  const mapOrders = new Set<number>();
  for (const map of context.maps) {
    if (
      !Number.isSafeInteger(map.mapOrder) ||
      map.mapOrder < 1 ||
      map.mapOrder > expectedCount ||
      map.mapName.trim().length === 0
    ) {
      return false;
    }
    mapOrders.add(map.mapOrder);
  }
  return mapOrders.size === expectedCount;
}

function knownMapIssue(
  context: MatchContext,
  evidence: NormalizedIdentityEvidence,
  hasCurrentEvidence: boolean,
  issues: IdentityIssue[],
): boolean {
  if (
    !hasCurrentEvidence ||
    evidence.mapName === undefined ||
    evidence.mapName.trim().length === 0
  ) {
    return false;
  }

  const knownMaps = new Set(context.maps.map((map) => map.mapName));
  if (knownMaps.has(evidence.mapName)) return false;
  if (!hasCompleteCanonicalMapSet(context)) {
    issues.push(
      issue(
        'map_not_confirmed',
        'warning',
        `当前 map ${evidence.mapName} 尚未被不完整的 canonical series map list 确认。`,
      ),
    );
    return false;
  }
  if (evidence.mapPhase === 'live') {
    issues.push(
      issue('map_mismatch', 'error', `live map ${evidence.mapName} 不属于当前 series maps。`),
    );
    return true;
  }
  issues.push(
    issue(
      'map_not_confirmed',
      'warning',
      `当前 map ${evidence.mapName} 尚未在正式 gameplay evidence 中确认。`,
    ),
  );
  return false;
}

function addCanonicalIssues(
  context: MatchContext,
  canonical: CanonicalIndex,
  issues: IdentityIssue[],
): void {
  for (const player of canonical.all) {
    if (player.steam64 === null || player.steam64.trim().length === 0) {
      issues.push(
        issue(
          'missing_canonical_steam64',
          'warning',
          `canonical player ${player.playerId} 缺少 Steam64，只影响该 player mapping。`,
          {
            canonicalPlayerId: player.playerId,
            entryId: player.entryId,
            affectsExpectedLineup: player.isStarter,
          },
        ),
      );
    }
    if (player.displayName === null || player.displayName.trim().length === 0) {
      issues.push(
        issue(
          'missing_canonical_display_name',
          'warning',
          `canonical player ${player.playerId} 缺少 RivalHub displayName。`,
          { canonicalPlayerId: player.playerId, entryId: player.entryId },
        ),
      );
    }
  }
  for (const playerId of canonical.duplicatePlayerIds) {
    issues.push(
      issue('duplicate_canonical_player_id', 'error', `canonical playerId ${playerId} 重复。`, {
        canonicalPlayerId: playerId,
      }),
    );
  }
  for (const steam64 of canonical.duplicateSteam64) {
    issues.push(
      issue('duplicate_canonical_steam64', 'error', `canonical Steam64 ${steam64} 重复。`, {
        steam64,
      }),
    );
  }
  for (const entrant of [context.entrants.a, context.entrants.b]) {
    if (entrant.players.length < 5) {
      issues.push(
        issue(
          'roster_incomplete',
          'warning',
          `参赛方 ${entrant.entryId} 的 canonical roster 少于五名选手。`,
          { entryId: entrant.entryId },
        ),
      );
    }
  }
}

function initialResolvingResolution(sourceGeneration = 0, mapEpoch = 0): IdentityResolution {
  return createResolution(
    'resolving',
    { sourceGeneration, mapEpoch },
    [],
    [],
    sideMappingUnknown(),
    [
      issue(
        'roster_evidence_pending',
        'info',
        '等待当前 source generation/map epoch 的 roster evidence。',
      ),
    ],
  );
}

export function unboundIdentityResolution(): IdentityResolution {
  return createResolution(
    'unbound',
    { sourceGeneration: 0, mapEpoch: 0 },
    [],
    [],
    sideMappingUnknown(),
    [issue('context_unbound', 'warning', '当前没有绑定 MatchContext。')],
  );
}

function unresolvedFromObserved(observed: ObservedPlayer): UnresolvedObservedPlayer {
  return {
    sourcePlayerId: observed.sourcePlayerId,
    displayName: observed.displayName ?? null,
    side: observed.side ?? 'unknown',
    observerSlot: observed.observerSlot ?? null,
  };
}

function resolveCurrentPlayers(
  currentPlayers: readonly ObservedPlayer[],
  canonical: CanonicalIndex,
  issues: IdentityIssue[],
): {
  readonly currentResolved: readonly ResolvedIdentityPlayer[];
  readonly unresolved: readonly UnresolvedObservedPlayer[];
  readonly duplicateObserved: boolean;
  readonly unexpectedHuman: boolean;
} {
  const resolvedByCanonicalId = new Map<string, ResolvedIdentityPlayer>();
  const unresolved: UnresolvedObservedPlayer[] = [];
  const seenObservedSourceIds = new Set<string>();
  let duplicateObserved = false;
  let unexpectedHuman = false;

  const sortedObserved = [...currentPlayers].sort((left, right) =>
    compareStrings(left.sourcePlayerId, right.sourcePlayerId),
  );
  for (const observed of sortedObserved) {
    const sourcePlayerId = observed.sourcePlayerId;
    const side = observed.side ?? 'unknown';
    const unresolvedPlayer = unresolvedFromObserved(observed);
    if (!STEAM64_PATTERN.test(sourcePlayerId)) {
      issues.push(
        issue(
          'bot_or_noncanonical_source_id',
          'warning',
          `source player ${sourcePlayerId} 不是可核验的 Steam64；不按昵称猜人。`,
          { sourcePlayerId },
        ),
      );
      unresolved.push(unresolvedPlayer);
      continue;
    }

    if (seenObservedSourceIds.has(sourcePlayerId)) {
      issues.push(
        issue(
          'duplicate_observed_identity',
          'warning',
          `当前 evidence 重复出现 Steam64 ${sourcePlayerId}；按同一 logical participant 去重。`,
          { sourcePlayerId, steam64: sourcePlayerId },
        ),
      );
      continue;
    }
    seenObservedSourceIds.add(sourcePlayerId);

    const canonicalPlayer = canonical.bySteam64.get(sourcePlayerId);
    if (canonicalPlayer === undefined) {
      unexpectedHuman = true;
      issues.push(
        issue(
          'unexpected_human_steam64',
          'warning',
          `观察到的 Steam64 ${sourcePlayerId} 不在当前完整 MatchRoster 中。`,
          { sourcePlayerId, steam64: sourcePlayerId },
        ),
      );
      unresolved.push(unresolvedPlayer);
      continue;
    }

    if (resolvedByCanonicalId.has(canonicalPlayer.playerId)) {
      duplicateObserved = true;
      issues.push(
        issue(
          'duplicate_observed_identity',
          'error',
          `canonical player ${canonicalPlayer.playerId} 在当前 evidence 中出现歧义映射。`,
          {
            sourcePlayerId,
            steam64: sourcePlayerId,
            canonicalPlayerId: canonicalPlayer.playerId,
          },
        ),
      );
      continue;
    }

    resolvedByCanonicalId.set(canonicalPlayer.playerId, {
      canonicalPlayerId: canonicalPlayer.playerId,
      entryId: canonicalPlayer.entryId,
      steam64: sourcePlayerId,
      displayName: canonicalPlayer.displayName,
      avatarUrl: canonicalPlayer.avatarUrl,
      isStarter: canonicalPlayer.isStarter,
      sourcePlayerId,
      observedDisplayName: observed.displayName ?? null,
      observerSlot: observed.observerSlot ?? null,
      side,
      evidence: 'current',
    });
    if (side === 'unknown') {
      issues.push(
        issue(
          'unknown_observed_side',
          'warning',
          `player ${canonicalPlayer.playerId} 当前 side 未知。`,
          { sourcePlayerId, canonicalPlayerId: canonicalPlayer.playerId },
        ),
      );
    }
  }

  return {
    currentResolved: sortResolvedPlayers(resolvedByCanonicalId.values()),
    unresolved: sortUnresolved(unresolved),
    duplicateObserved,
    unexpectedHuman,
  };
}

export function resolveIdentity(
  context: MatchContext | undefined,
  input: IdentityObservationInput,
  previous?: IdentityResolution,
): IdentityResolution {
  if (context === undefined) return unboundIdentityResolution();

  const evidence = normalizeIdentityEvidence(input);
  const issues: IdentityIssue[] = [];
  const compatiblePrevious =
    previous !== undefined &&
    previous.sourceGeneration === evidence.sourceGeneration &&
    previous.mapEpoch === evidence.mapEpoch;

  if (previous !== undefined && previous.sourceGeneration !== evidence.sourceGeneration) {
    issues.push(
      issue(
        'source_generation_changed',
        'info',
        'source generation 已变化；旧 identity proof 不作为新 baseline。',
      ),
    );
  }
  if (previous !== undefined && previous.mapEpoch !== evidence.mapEpoch) {
    issues.push(
      issue('map_epoch_changed', 'info', 'map epoch 已变化；旧 identity proof 不作为新 baseline。'),
    );
  }

  const canonical = buildCanonicalIndex(context);
  addCanonicalIssues(context, canonical, issues);
  const hasCurrentEvidence = evidence.allPlayers !== undefined;
  const currentPlayers = evidence.allPlayers ?? [];
  const canonicalPlayersByEntry = new Map<string, number>();
  const canonicalSteam64ByEntry = new Map<string, number>();
  for (const player of canonical.all) {
    canonicalPlayersByEntry.set(
      player.entryId,
      (canonicalPlayersByEntry.get(player.entryId) ?? 0) + 1,
    );
    if (player.steam64 !== null && STEAM64_PATTERN.test(player.steam64)) {
      canonicalSteam64ByEntry.set(
        player.entryId,
        (canonicalSteam64ByEntry.get(player.entryId) ?? 0) + 1,
      );
    }
  }
  const canonicalRosterComplete = [context.entrants.a, context.entrants.b].every(
    (entrant) => (canonicalPlayersByEntry.get(entrant.entryId) ?? 0) >= 5,
  );
  const canonicalFiveSteam64Ready =
    canonical.duplicateSteam64.size === 0 &&
    [context.entrants.a, context.entrants.b].every(
      (entrant) => (canonicalSteam64ByEntry.get(entrant.entryId) ?? 0) >= 5,
    );
  const mapMismatch = knownMapIssue(context, evidence, hasCurrentEvidence, issues);

  if (!hasCurrentEvidence || evidence.allPlayersCoverage === 'absent') {
    issues.push(
      issue(
        evidence.allPlayersCoverage === 'degraded'
          ? 'allplayers_degraded'
          : 'allplayers_unavailable',
        'warning',
        compatiblePrevious && previous?.players.length !== 0
          ? '当前 frame 没有 allplayers；保留同一 proof 的已知 identity。'
          : evidence.allPlayersCoverage === 'degraded'
            ? '当前 allplayers evidence degraded，尚无可用于身份核验的完整 roster。'
            : '当前没有足够新鲜的 allplayers roster evidence。',
      ),
    );
    if (compatiblePrevious && previous !== undefined && previous.players.length > 0) {
      const state: IdentityState =
        previous.state === 'mismatch'
          ? 'mismatch'
          : previous.state === 'matched'
            ? 'matched'
            : 'degraded';
      return createResolution(
        state,
        evidence,
        previous.players.map((player) => ({ ...player, evidence: 'retained' })),
        previous.unresolved,
        previous.sideMapping,
        issues,
      );
    }
    return createResolution('resolving', evidence, [], [], sideMappingUnknown(), issues);
  }

  if (evidence.allPlayersCoverage === 'degraded') {
    issues.push(issue('allplayers_degraded', 'warning', 'allplayers evidence 已标记为 degraded。'));
  }

  const resolved = resolveCurrentPlayers(currentPlayers, canonical, issues);
  const resolvedCountsByEntry = new Map<string, number>();
  for (const player of resolved.currentResolved) {
    resolvedCountsByEntry.set(player.entryId, (resolvedCountsByEntry.get(player.entryId) ?? 0) + 1);
  }
  const resolvedByCanonicalId = new Map(
    resolved.currentResolved.map((player) => [player.canonicalPlayerId, player] as const),
  );
  const sideMapping = deriveSideMapping(
    context,
    evidence,
    resolved.currentResolved,
    compatiblePrevious ? previous : undefined,
    issues,
  );
  const sideComplete =
    sideMapping.a !== 'unknown' && sideMapping.b !== 'unknown' && sideMapping.a !== sideMapping.b;
  const currentObservedFiveVsFiveEvidence =
    evidence.allPlayersCoverage === 'present' &&
    currentPlayers.length === 10 &&
    !resolved.duplicateObserved &&
    currentPlayers.every((player) => player.side === 'CT' || player.side === 'T') &&
    currentPlayers.filter((player) => player.side === 'CT').length === 5 &&
    currentPlayers.filter((player) => player.side === 'T').length === 5;
  const currentCanonicalFiveVsFiveEvidence =
    currentObservedFiveVsFiveEvidence &&
    resolved.currentResolved.length === 10 &&
    resolved.unresolved.length === 0 &&
    (resolvedCountsByEntry.get(context.entrants.a.entryId) ?? 0) === 5 &&
    (resolvedCountsByEntry.get(context.entrants.b.entryId) ?? 0) === 5 &&
    resolved.currentResolved.every((player) => player.side !== 'unknown') &&
    sideComplete;

  if (!currentObservedFiveVsFiveEvidence) {
    issues.push(
      issue(
        'partial_roster_evidence',
        'warning',
        '当前 evidence 尚不能证明双方各五名已通过 Steam64 与 side 核验的选手。',
      ),
    );
  }

  const currentPositiveContradiction =
    resolved.duplicateObserved ||
    mapMismatch ||
    issues.some((item) => item.code === 'ambiguous_side_mapping' && item.severity === 'error') ||
    canonical.duplicatePlayerIds.size > 0 ||
    canonical.duplicateSteam64.size > 0;

  // A degraded allplayers frame is a health/freshness signal, not an
  // automatic identity revocation. The current frame is still scanned above
  // so a positive contradiction (notably duplicate/ambiguous Steam64) wins.
  if (
    evidence.allPlayersCoverage === 'degraded' &&
    compatiblePrevious &&
    previous?.state === 'matched' &&
    previous.players.length > 0 &&
    !currentPositiveContradiction
  ) {
    return createResolution(
      'matched',
      evidence,
      previous.players.map((player) => ({ ...player, evidence: 'retained' })),
      previous.unresolved,
      previous.sideMapping,
      issues,
    );
  }

  if (
    compatiblePrevious &&
    previous !== undefined &&
    !currentObservedFiveVsFiveEvidence &&
    !currentPositiveContradiction
  ) {
    for (const player of previous.players) {
      if (!resolvedByCanonicalId.has(player.canonicalPlayerId)) {
        resolvedByCanonicalId.set(player.canonicalPlayerId, {
          ...player,
          evidence: 'retained',
        });
      }
    }
  }
  const allResolved = sortResolvedPlayers(resolvedByCanonicalId.values());

  if (currentCanonicalFiveVsFiveEvidence) {
    const expectedStarterIds = new Set(
      canonical.all.filter((player) => player.isStarter).map((player) => player.playerId),
    );
    const currentStarterIds = new Set(
      resolved.currentResolved
        .filter((player) => player.isStarter)
        .map((player) => player.canonicalPlayerId),
    );
    const hasSubstitute = resolved.currentResolved.some((player) => !player.isStarter);
    const starterMissing = [...expectedStarterIds].some(
      (playerId) => !currentStarterIds.has(playerId),
    );
    if (hasSubstitute || starterMissing) {
      issues.push(
        issue(
          'lineup_differs_from_expected',
          'warning',
          '当前 lineup 与预期首发不同，但所有已识别选手仍来自完整 MatchRoster。',
        ),
      );
    }
  }

  let state: IdentityState;
  if (currentPositiveContradiction) {
    state = 'mismatch';
  } else if (
    canonicalRosterComplete &&
    canonicalFiveSteam64Ready &&
    currentCanonicalFiveVsFiveEvidence
  ) {
    state = 'matched';
  } else {
    state = 'degraded';
  }

  return createResolution(state, evidence, allResolved, resolved.unresolved, sideMapping, issues);
}

export class IdentityResolver {
  private context: MatchContext | undefined;
  private resolution: IdentityResolution;

  constructor(context?: MatchContext) {
    this.context = context;
    this.resolution =
      context === undefined ? unboundIdentityResolution() : initialResolvingResolution();
  }

  bind(context: MatchContext): IdentityResolution {
    this.context = context;
    this.resolution = initialResolvingResolution();
    return this.resolution;
  }

  unbind(): IdentityResolution {
    this.context = undefined;
    this.resolution = unboundIdentityResolution();
    return this.resolution;
  }

  resolve(input: IdentityObservationInput): IdentityResolution {
    this.resolution = resolveIdentity(this.context, input, this.resolution);
    return this.resolution;
  }

  getResolution(): IdentityResolution {
    return this.resolution;
  }
}

export function createIdentityResolver(context?: MatchContext): IdentityResolver {
  return new IdentityResolver(context);
}
