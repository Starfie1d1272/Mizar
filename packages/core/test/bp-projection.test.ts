import { describe, expect, it } from 'vitest';
import { inspectBp, localBpSequence, projectBp } from '../src/projection/index.js';
import type { MatchContext, MatchFormat } from '../src/match-context/index.js';

const mapPool = [
  'de_mirage',
  'de_inferno',
  'de_nuke',
  'de_ancient',
  'de_dust2',
  'de_anubis',
  'de_cache',
];
type SideMode = 'explicit' | 'legacy' | 'outcome-only' | 'none';

function contextFor(format: MatchFormat, mode: SideMode = 'explicit'): MatchContext {
  const actions = localBpSequence(format, 'a');
  const bans = ['de_ancient', 'de_inferno', 'de_dust2', 'de_anubis', 'de_cache', 'de_nuke'];
  let banIndex = 0;
  const pickMaps =
    format === 'bo1'
      ? []
      : format === 'bo3'
        ? ['de_mirage', 'de_overpass']
        : ['de_mirage', 'de_overpass', 'de_train', 'de_vertigo'];
  const used = new Set<string>(bans.slice(0, format === 'bo1' ? 6 : format === 'bo3' ? 4 : 2));
  pickMaps.forEach((name) => used.add(name));
  const deciderMap = mapPool.find((name) => !used.has(name)) ?? 'de_train';
  const sideByMap = new Map<string, { actor: 'a' | 'b'; side: 'CT' | 'T' }>();
  let sideIndex = 0;
  for (const action of actions) {
    if (action.kind !== 'side_pick') continue;
    const side = action.target === 'decider' ? 'T' : sideIndex % 2 === 0 ? 'CT' : 'T';
    const mapName = action.target === 'decider' ? deciderMap : pickMaps[action.targetIndex]!;
    sideByMap.set(mapName, { actor: action.actor, side });
    sideIndex += 1;
  }
  const mapNameFor = (action: (typeof actions)[number]) => {
    if (action.kind === 'ban') return bans[banIndex++]!;
    if (action.kind === 'pick') return pickMaps[action.valueIndex]!;
    if (action.kind === 'side_pick')
      return action.target === 'decider' ? deciderMap : pickMaps[action.targetIndex]!;
    return deciderMap;
  };
  const veto: MatchContext['veto'][number][] = [];
  for (const action of actions) {
    const mapName = mapNameFor(action);
    if (action.kind === 'side_pick') {
      if (mode === 'explicit') {
        const choice = sideByMap.get(mapName)!;
        veto.push({
          stepOrder: veto.length + 1,
          actionType: 'side_pick',
          mapName,
          entryId: choice.actor === 'a' ? 'entry-a' : 'entry-b',
          side: choice.side,
        });
      }
      continue;
    }
    const sideChoice = sideByMap.get(mapName);
    const side = mode === 'legacy' && sideChoice !== undefined ? sideChoice.side : null;
    const entryId =
      action.kind === 'decider'
        ? mode === 'legacy' && sideChoice !== undefined
          ? sideChoice.actor === 'a'
            ? 'entry-a'
            : 'entry-b'
          : null
        : action.actor === 'a'
          ? 'entry-a'
          : action.actor === 'b'
            ? 'entry-b'
            : null;
    veto.push({
      stepOrder: veto.length + 1,
      actionType: action.kind,
      mapName,
      entryId,
      side,
    });
  }
  const cards = actions.filter((action) => action.kind !== 'side_pick');
  const maps = cards.flatMap((action, index) => {
    if (action.kind === 'ban') return [];
    const mapName = action.kind === 'pick' ? pickMaps[action.valueIndex]! : deciderMap;
    const choice = sideByMap.get(mapName);
    const sideEvidence = mode === 'explicit' || mode === 'legacy' ? choice : undefined;
    const teamAStartSide =
      sideEvidence === undefined
        ? null
        : sideEvidence.actor === 'a'
          ? sideEvidence.side
          : sideEvidence.side === 'CT'
            ? 'T'
            : 'CT';
    const pickedByEntryId =
      action.kind === 'pick' ? (action.actor === 'a' ? 'entry-a' : 'entry-b') : null;
    return [
      {
        mapId: `map-${index}`,
        mapOrder: index + 1,
        mapName,
        pickedByEntryId,
        teamAStartSide: mode === 'outcome-only' ? 'CT' : teamAStartSide,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      },
    ];
  });
  return {
    matchId: 'bp-boundary',
    competition: { competitionId: 'c', slug: 'c', name: '比赛', themeColor: null },
    status: 'scheduled',
    format,
    stage: '决赛',
    round: null,
    entryRound: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    scoreA: null,
    scoreB: null,
    isForfeit: false,
    entrants: {
      a: { entryId: 'entry-a', name: '完整左队名', logoUrl: null, rosterId: null, players: [] },
      b: { entryId: 'entry-b', name: '完整右队名', logoUrl: null, rosterId: null, players: [] },
    },
    maps,
    veto,
    commentators: [],
  };
}

describe('BP canonical projection', () => {
  it.each(['bo1', 'bo3', 'bo5'] as const)(
    'keeps %s card order, entrant A/B orientation, and only the side-choice actor',
    (format) => {
      const result = projectBp(contextFor(format))!;
      expect(result.format).toBe(format);
      expect(result.cards).toHaveLength(7);
      expect(result.cards.at(-1)).toMatchObject({ kind: 'decider', entrant: null });
      expect(result.steps.filter((step) => step.kind === 'side-choice')).toHaveLength(
        format === 'bo1' ? 1 : format === 'bo3' ? 3 : 4,
      );
      expect(
        result.cards.find((card) => card.kind === (format === 'bo1' ? 'decider' : 'pick'))
          ?.sideChoice,
      ).toEqual({ entrant: 'b', side: format === 'bo1' ? 'T' : 'CT' });
      expect(result.entrants.a.name).toBe('完整左队名');
      expect(result.entrants.b.name).toBe('完整右队名');
      expect(result).not.toHaveProperty('commentators');
      expect(result.entrants.a).not.toHaveProperty('players');
    },
  );

  it('normalizes legacy PICK.side as the opponent choice and legacy DECIDER.side as its entry owner', () => {
    const result = projectBp(contextFor('bo3', 'legacy'))!;
    expect(result.cards.find((card) => card.kind === 'pick')?.sideChoice).toEqual({
      entrant: 'b',
      side: 'CT',
    });
    expect(result.cards.at(-1)?.sideChoice).toEqual({ entrant: 'b', side: 'T' });
  });

  it('does not invent a selector from teamAStartSide alone', () => {
    const result = projectBp(contextFor('bo3', 'outcome-only'))!;
    expect(result.cards.every((card) => card.sideChoice === null)).toBe(true);
    expect(result.steps.every((step) => step.kind === 'card')).toBe(true);
  });

  it('fails closed when explicit, legacy, or final map-side evidence conflicts', () => {
    const source = contextFor('bo3');
    const withLegacy = source.veto.map((step) =>
      step.actionType === 'pick' && step.mapName === 'de_mirage'
        ? { ...step, side: 'T' as const }
        : step,
    );
    expect(inspectBp({ ...source, veto: withLegacy }).readiness).toBe('conflict');
    expect(
      inspectBp({
        ...source,
        maps: source.maps.map((map) =>
          map.mapName === 'de_mirage' ? { ...map, teamAStartSide: 'CT' as const } : map,
        ),
      }).readiness,
    ).toBe('conflict');
  });

  it('marks absent and partial vetoes incomplete and duplicate actions conflicting', () => {
    expect(inspectBp({ ...contextFor('bo3'), veto: [] }).readiness).toBe('incomplete');
    expect(
      inspectBp({
        ...contextFor('bo3'),
        veto: [...contextFor('bo3').veto.slice(0, 2)],
      }).readiness,
    ).toBe('incomplete');
    expect(
      inspectBp({
        ...contextFor('bo3'),
        veto: [...contextFor('bo3').veto, { ...contextFor('bo3').veto[0]!, stepOrder: 1 }],
      }).readiness,
    ).toBe('conflict');
    expect(projectBp(undefined)).toBeNull();
  });
});
