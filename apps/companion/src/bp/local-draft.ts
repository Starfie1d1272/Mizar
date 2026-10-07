import { randomUUID } from 'node:crypto';

import {
  DEFAULT_LOCAL_BP_MAP_POOL,
  DEFAULT_BO3_BP_RULES,
  LOCAL_BP_MAP_CATALOG,
  localBpSequence,
  type BpSideChoice,
  type Bo3BpRules,
} from '@mizar/core/projection';
import { localBpDraftSchema, type LocalBpDraft } from '@mizar/protocol/bp';
import type { BroadcastManifestV1, BroadcastSide } from '@mizar/rivalhub';
import { canonicalizeCs2MapName } from '@mizar/core/map-name';
import type { MatchContextBinding } from '../match-context/index.js';
import { isLocalBinding, localAuthoringMode } from '../match-context/lkg-store.js';

export type LocalBpDraftResult =
  | { readonly ok: true; readonly manifest: BroadcastManifestV1 }
  | { readonly ok: false; readonly code: string; readonly message: string };

const mapCatalog = new Set<string>(LOCAL_BP_MAP_CATALOG.map(({ mapName }) => mapName));

function invalid(code: string, message: string): LocalBpDraftResult {
  return { ok: false, code, message };
}

function safeLogoUrl(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length === 0) return true;
  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    return ![...candidate].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === '\\' || code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function localSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'local-match';
}

function authoringSideChoices(binding: MatchContextBinding): ReadonlyMap<string, BpSideChoice> {
  const { context } = binding;
  const keyFor = (name: string) => canonicalizeCs2MapName(name) ?? name.trim().toLowerCase();
  const entrantFor = (entryId: string | null): 'a' | 'b' | null => {
    if (entryId === null) return null;
    if (entryId === context.entrants.a.entryId && entryId !== context.entrants.b.entryId)
      return 'a';
    if (entryId === context.entrants.b.entryId && entryId !== context.entrants.a.entryId)
      return 'b';
    return null;
  };
  const oppositeEntrant = (entrant: 'a' | 'b') => (entrant === 'a' ? 'b' : 'a');
  const evidence = new Map<
    string,
    { explicit: BpSideChoice[]; legacy: BpSideChoice[]; kind?: 'ban' | 'pick' | 'decider' }
  >();
  const ambiguous = new Set<string>();
  const ordered = [...context.veto].sort((a, b) => a.stepOrder - b.stepOrder);
  if (new Set(ordered.map((step) => step.stepOrder)).size !== ordered.length) return new Map();

  for (const step of ordered) {
    const mapKey = keyFor(step.mapName);
    const record = evidence.get(mapKey) ?? { explicit: [], legacy: [] };
    if (step.actionType === 'side_pick') {
      const choiceMaker = entrantFor(step.entryId);
      if (choiceMaker === null || step.side === null) {
        evidence.set(mapKey, record);
        continue;
      }
      record.explicit.push({ entrant: choiceMaker, side: step.side });
      evidence.set(mapKey, record);
      continue;
    }

    if (record.kind !== undefined) ambiguous.add(mapKey);
    record.kind = step.actionType;
    if (step.side !== null) {
      const owner = entrantFor(step.entryId);
      const choiceMaker =
        step.actionType === 'pick' && owner !== null
          ? oppositeEntrant(owner)
          : step.actionType === 'decider'
            ? owner
            : null;
      if (choiceMaker !== null) record.legacy.push({ entrant: choiceMaker, side: step.side });
    }
    evidence.set(mapKey, record);
  }

  const mapCounts = new Map<string, number>();
  for (const map of context.maps) {
    const key = keyFor(map.mapName);
    mapCounts.set(key, (mapCounts.get(key) ?? 0) + 1);
  }
  const mapByName = new Map(context.maps.map((map) => [keyFor(map.mapName), map]));
  const recovered = new Map<string, BpSideChoice>();
  for (const [mapKey, record] of evidence) {
    if (
      ambiguous.has(mapKey) ||
      record.kind === 'ban' ||
      record.explicit.length > 1 ||
      record.legacy.length > 1 ||
      (mapCounts.get(mapKey) ?? 0) > 1
    )
      continue;
    const explicit = record.explicit[0];
    const legacy = record.legacy[0];
    if (
      explicit !== undefined &&
      legacy !== undefined &&
      (explicit.entrant !== legacy.entrant || explicit.side !== legacy.side)
    )
      continue;
    const choice = explicit ?? legacy;
    if (choice === undefined || (record.kind === 'decider' && context.format === 'bo5')) continue;
    const map = mapByName.get(mapKey);
    const expectedTeamA = choice.entrant === 'a' ? choice.side : choice.side === 'CT' ? 'T' : 'CT';
    if (map?.teamAStartSide != null && map.teamAStartSide !== expectedTeamA) continue;
    recovered.set(mapKey, choice);
  }
  return recovered;
}

export function createLocalBpManifest(
  input: unknown,
  baseBinding?: MatchContextBinding,
): LocalBpDraftResult {
  const parsed = localBpDraftSchema.safeParse(input);
  if (!parsed.success) return invalid('bp_draft_invalid', '本地 BP 信息格式有误，请检查填写内容。');
  const draft = parsed.data;
  const rules =
    draft.bo3Rules ?? (baseBinding && existingBo3Rules(baseBinding)) ?? DEFAULT_BO3_BP_RULES;
  const sequence = localBpSequence(draft.format, draft.vetoA, rules);
  const deciderHasSidePick = sequence.some(
    (action) => action.kind === 'side_pick' && action.target === 'decider',
  );
  const baseManifest = baseBinding?.manifest;
  const editableStandalone =
    baseManifest === undefined || localAuthoringMode(baseBinding) === 'standalone';
  const inheritedLogoMatches = (entrant: 'a' | 'b') => {
    const baseLogo = baseManifest?.entrants[entrant].logoUrl?.trim() || null;
    return (draft.entrants[entrant].logoUrl?.trim() || null) === baseLogo;
  };
  const shouldValidateLogo = (entrant: 'a' | 'b') =>
    baseManifest === undefined || (editableStandalone && !inheritedLogoMatches(entrant));
  if (
    baseManifest !== undefined &&
    !editableStandalone &&
    (draft.competitionName.trim() !== baseManifest.match.competition.name.trim() ||
      draft.stage.trim() !== baseManifest.match.stage.trim() ||
      draft.format !== baseManifest.match.format ||
      draft.entrants.a.name.trim() !== baseManifest.entrants.a.name.trim() ||
      draft.entrants.b.name.trim() !== baseManifest.entrants.b.name.trim() ||
      !inheritedLogoMatches('a') ||
      !inheritedLogoMatches('b'))
  )
    return invalid(
      'bp_bound_identity_locked',
      '当前比赛身份已绑定；本地补录只修改 BP，不会更改赛事、赛制、队伍或队标。',
    );
  const pool = draft.mapPool.map((name) => canonicalizeCs2MapName(name));
  const bans = draft.bans.map((name) => canonicalizeCs2MapName(name));
  const picks = draft.picks.map((pick) => ({
    mapName: canonicalizeCs2MapName(pick.mapName),
    side: pick.side,
  }));
  if (
    (baseManifest === undefined || editableStandalone) &&
    (draft.entrants.a.name.trim() === '' || draft.entrants.b.name.trim() === '')
  )
    return invalid('bp_draft_names_required', '请填写两支队伍的名称。');
  if (shouldValidateLogo('a') && !safeLogoUrl(draft.entrants.a.logoUrl ?? ''))
    return invalid('bp_draft_logo_invalid', '队标地址需使用 HTTPS 或本地相对路径。');
  if (shouldValidateLogo('b') && !safeLogoUrl(draft.entrants.b.logoUrl ?? ''))
    return invalid('bp_draft_logo_invalid', '队标地址需使用 HTTPS 或本地相对路径。');
  if (
    pool.length !== 7 ||
    pool.some((name) => name === null || !mapCatalog.has(name)) ||
    new Set(pool).size !== 7
  )
    return invalid('bp_draft_map_pool_invalid', '地图池必须从支持的地图中选出 7 张且不能重复。');

  const expectedBans = draft.format === 'bo1' ? 6 : draft.format === 'bo3' ? 4 : 2;
  const expectedPicks = draft.format === 'bo1' ? 0 : draft.format === 'bo3' ? 2 : 4;
  if (
    bans.length !== expectedBans ||
    picks.length !== expectedPicks ||
    bans.some((name) => name === null || !mapCatalog.has(name)) ||
    picks.some((pick) => pick.mapName === null || !mapCatalog.has(pick.mapName))
  )
    return invalid('bp_draft_maps_incomplete', '请完成所有禁用地图和选择地图。');
  if (
    picks.some((pick) => pick.side === null) ||
    (deciderHasSidePick && draft.deciderSide === null)
  )
    return invalid(
      'bp_draft_sides_incomplete',
      '请填写每张已选地图的 CT / T，以及适用的决胜图选边。',
    );
  if (draft.format === 'bo5' && draft.deciderSide !== null)
    return invalid('bp_draft_decider_knife', 'BO5 决胜图使用 knife round，不填写起始边。');
  if (draft.format === 'bo3' && !deciderHasSidePick && draft.deciderSide !== null)
    return invalid('bp_draft_decider_in_game', '决胜图阵营由游戏内决定，不预填起始边。');

  const selected = [...bans, ...picks.map((pick) => pick.mapName)].filter(
    (name): name is string => name !== null,
  );
  if (selected.some((name) => !pool.includes(name)) || new Set(selected).size !== selected.length)
    return invalid('bp_draft_maps_duplicate', '每张地图只能使用一次，且必须来自所选地图池。');
  const remaining = pool.filter(
    (name): name is string => name !== null && !selected.includes(name),
  );
  if (remaining.length !== 1)
    return invalid('bp_draft_decider_invalid', '剩余地图不唯一，无法确定决胜图。');

  const entryId = baseManifest
    ? { a: baseManifest.entrants.a.entryId, b: baseManifest.entrants.b.entryId }
    : { a: randomUUID(), b: randomUUID() };
  const matchId = baseManifest?.match.matchId ?? randomUUID();
  const mapForPick = draft.picks.map((pick) => canonicalizeCs2MapName(pick.mapName)!);
  const deciderMap = remaining[0]!;
  const sideChoiceFor = (target: 'pick' | 'decider', index: number): 'CT' | 'T' | null =>
    target === 'pick' ? (draft.picks[index]?.side ?? null) : draft.deciderSide;
  const mapNameFor = (action: (typeof sequence)[number]): string => {
    if (action.kind === 'ban') return canonicalizeCs2MapName(draft.bans[action.valueIndex]!)!;
    if (action.kind === 'pick') return mapForPick[action.valueIndex]!;
    if (action.kind === 'side_pick')
      return action.target === 'decider' ? deciderMap : mapForPick[action.targetIndex]!;
    return deciderMap;
  };
  const veto = sequence.map((action, index) => {
    const mapName = mapNameFor(action);
    if (action.kind === 'side_pick') {
      const side = sideChoiceFor(action.target, action.targetIndex);
      const wireSide: BroadcastSide | null = side === null ? null : side === 'CT' ? 'ct' : 't';
      return {
        stepOrder: index + 1,
        actionType: 'side_pick' as const,
        mapName,
        entryId: entryId[action.actor],
        side: wireSide,
      };
    }
    return {
      stepOrder: index + 1,
      actionType: action.kind,
      mapName,
      entryId: action.actor === null ? null : entryId[action.actor],
      side: null,
    };
  });
  const pickMapNames = [...mapForPick, deciderMap];
  const plannedMaps = pickMapNames.map((mapName, index) => {
    const choice = sequence.find(
      (action) =>
        action.kind === 'side_pick' &&
        ((index < mapForPick.length && action.target === 'pick' && action.targetIndex === index) ||
          (index === mapForPick.length && action.target === 'decider')),
    );
    const selectedSide =
      choice?.kind === 'side_pick' ? sideChoiceFor(choice.target, choice.targetIndex) : null;
    const teamAStartSide: BroadcastSide | null =
      selectedSide === null || choice?.kind !== 'side_pick'
        ? null
        : choice.actor === 'a'
          ? selectedSide === 'CT'
            ? 'ct'
            : 't'
          : selectedSide === 'CT'
            ? 't'
            : 'ct';
    const picker = sequence.find((action) => action.kind === 'pick' && action.valueIndex === index);
    return {
      mapOrder: index + 1,
      mapName,
      pickedByEntryId:
        index < mapForPick.length && picker?.kind === 'pick' ? entryId[picker.actor] : null,
      teamAStartSide,
      scoreA: null,
      scoreB: null,
      completedAt: null,
    };
  });
  const maps: BroadcastManifestV1['maps'][number][] = [];
  for (const planned of plannedMaps) {
    const existing = baseManifest?.maps.find((map) => map.mapOrder === planned.mapOrder);
    const played =
      existing !== undefined &&
      (existing.scoreA !== null || existing.scoreB !== null || existing.completedAt !== null);
    if (played) {
      if (
        existing.mapName !== planned.mapName ||
        (existing.pickedByEntryId !== null &&
          existing.pickedByEntryId !== planned.pickedByEntryId) ||
        (existing.teamAStartSide !== null && existing.teamAStartSide !== planned.teamAStartSide)
      )
        return invalid(
          'bp_played_map_conflict',
          '已完成地图的地图顺序、选图方或起始边不能通过本地 BP 修改。',
        );
      maps.push(existing);
      continue;
    }
    maps.push({
      ...planned,
      mapId: existing?.mapName === planned.mapName ? existing.mapId : randomUUID(),
    });
  }
  const competitionName = draft.competitionName.trim() || '本地赛事';
  const revision = `local-${randomUUID()}`;
  const stage = draft.stage.trim() || '本地比赛';
  let manifest: BroadcastManifestV1;
  if (baseManifest !== undefined) {
    const match = editableStandalone
      ? {
          ...baseManifest.match,
          competition: {
            ...baseManifest.match.competition,
            name: competitionName,
            slug:
              competitionName === baseManifest.match.competition.name
                ? baseManifest.match.competition.slug
                : localSlug(competitionName),
          },
          format: draft.format,
          stage,
        }
      : baseManifest.match;
    const entrants = editableStandalone
      ? {
          a: {
            ...baseManifest.entrants.a,
            name: draft.entrants.a.name.trim(),
            logoUrl: draft.entrants.a.logoUrl?.trim() || null,
          },
          b: {
            ...baseManifest.entrants.b,
            name: draft.entrants.b.name.trim(),
            logoUrl: draft.entrants.b.logoUrl?.trim() || null,
          },
        }
      : baseManifest.entrants;
    manifest = { ...baseManifest, revision, match, entrants, maps, veto };
  } else {
    manifest = {
      schemaVersion: 'rivalhub.broadcast-manifest.v1',
      revision,
      match: {
        matchId,
        competition: {
          competitionId: `local-${randomUUID()}`,
          slug: localSlug(competitionName),
          name: competitionName,
          themeColor: null,
        },
        status: 'scheduled',
        format: draft.format,
        stage,
        round: null,
        entryRound: null,
        scheduledAt: null,
        startedAt: null,
        completedAt: null,
        scoreA: null,
        scoreB: null,
        isForfeit: false,
      },
      entrants: {
        a: {
          entryId: entryId.a,
          name: draft.entrants.a.name.trim(),
          logoUrl: draft.entrants.a.logoUrl?.trim() || null,
          roster: { rosterId: null, players: [] },
        },
        b: {
          entryId: entryId.b,
          name: draft.entrants.b.name.trim(),
          logoUrl: draft.entrants.b.logoUrl?.trim() || null,
          roster: { rosterId: null, players: [] },
        },
      },
      maps,
      veto,
      commentators: [],
    };
  }
  return { ok: true, manifest };
}

function existingBo3Rules(
  binding: MatchContextBinding,
  defaults: Bo3BpRules = DEFAULT_BO3_BP_RULES,
): Bo3BpRules | undefined {
  if (binding.context.format !== 'bo3') return undefined;
  const steps = [...binding.context.veto].sort((a, b) => a.stepOrder - b.stepOrder);
  const bans = steps.filter((step) => step.actionType === 'ban');
  const deciders = steps.filter((step) => step.actionType === 'decider');
  if (bans.length !== 4 || deciders.length !== 1 || !bans[0]?.entryId) return undefined;
  const first = bans[0].entryId;
  const other =
    first === binding.context.entrants.a.entryId
      ? binding.context.entrants.b.entryId
      : binding.context.entrants.a.entryId;
  if (!bans.every((step) => step.entryId === first || step.entryId === other)) return undefined;
  const decider = deciders[0]!;
  const side = steps.find(
    (step) => step.actionType === 'side_pick' && step.mapName === decider.mapName,
  );
  const chooser = side?.entryId ?? (decider.side === null ? null : decider.entryId);
  const explicitPickSides = steps.filter(
    (step) =>
      step.actionType === 'side_pick' &&
      step.mapName !== decider.mapName &&
      step.side !== null &&
      step.entryId !== null,
  );
  return {
    finalBanOrder: bans[2]?.entryId === first ? 'veto_a_first' : 'veto_b_first',
    deciderSideChoice:
      chooser === first
        ? 'veto_a'
        : chooser === other
          ? 'veto_b'
          : explicitPickSides.length === 2
            ? 'in_game'
            : defaults.deciderSideChoice,
  };
}

export function bpAuthoringDraftFromBinding(
  binding: MatchContextBinding,
  eventRules?: Bo3BpRules,
): LocalBpDraft {
  const manifest = binding.manifest;
  const firstBan = manifest.veto.find((step) => step.actionType === 'ban');
  const vetoA = firstBan?.entryId === manifest.entrants.b.entryId ? 'b' : 'a';
  const sideChoices = authoringSideChoices(binding);
  const poolNames = new Set(
    [...manifest.veto.map((step) => step.mapName), ...manifest.maps.map((map) => map.mapName)]
      .map((name) => canonicalizeCs2MapName(name))
      .filter((name): name is string => name !== null && mapCatalog.has(name)),
  );
  const catalogOrder = LOCAL_BP_MAP_CATALOG.map(({ mapName }) => mapName);
  const mapPool = catalogOrder.filter((mapName) => poolNames.has(mapName)).slice(0, 7);
  for (const mapName of [...DEFAULT_LOCAL_BP_MAP_POOL, ...catalogOrder]) {
    if (mapPool.length === 7) break;
    if (!mapPool.includes(mapName)) mapPool.push(mapName);
  }
  const expectedBans =
    manifest.match.format === 'bo1' ? 6 : manifest.match.format === 'bo3' ? 4 : 2;
  const expectedPicks =
    manifest.match.format === 'bo1' ? 0 : manifest.match.format === 'bo3' ? 2 : 4;
  const bans = manifest.veto
    .filter((step) => step.actionType === 'ban')
    .slice(0, expectedBans)
    .map((step) => canonicalizeCs2MapName(step.mapName) ?? '');
  while (bans.length < expectedBans) bans.push('');
  const pickSteps = manifest.veto
    .filter((step) => step.actionType === 'pick')
    .slice(0, expectedPicks);
  const picks = pickSteps.map((step) => ({
    mapName: canonicalizeCs2MapName(step.mapName) ?? '',
    side: sideChoices.get(canonicalizeCs2MapName(step.mapName) ?? step.mapName)?.side ?? null,
  }));
  while (picks.length < expectedPicks) picks.push({ mapName: '', side: null });
  const decider = manifest.veto.find((step) => step.actionType === 'decider');
  const deciderName = decider === undefined ? null : canonicalizeCs2MapName(decider.mapName);
  const deciderSide =
    deciderName === null || deciderName === undefined
      ? null
      : (sideChoices.get(deciderName)?.side ?? null);
  return {
    competitionName: manifest.match.competition.name,
    stage: manifest.match.stage,
    format: manifest.match.format,
    entrants: {
      a: { name: manifest.entrants.a.name, logoUrl: manifest.entrants.a.logoUrl },
      b: { name: manifest.entrants.b.name, logoUrl: manifest.entrants.b.logoUrl },
    },
    vetoA,
    bo3Rules: existingBo3Rules(binding, eventRules) ?? eventRules ?? DEFAULT_BO3_BP_RULES,
    mapPool: [...mapPool],
    bans,
    picks,
    deciderSide: manifest.match.format === 'bo5' ? null : deciderSide,
  };
}

export function localBpDraftFromBinding(
  binding: MatchContextBinding,
  eventRules?: Bo3BpRules,
): LocalBpDraft | null {
  return isLocalBinding(binding) ? bpAuthoringDraftFromBinding(binding, eventRules) : null;
}

export const localBpMapOptions = LOCAL_BP_MAP_CATALOG;
export const defaultLocalBpMapPool = DEFAULT_LOCAL_BP_MAP_POOL;
