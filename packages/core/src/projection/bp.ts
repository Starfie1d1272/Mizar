import type { MatchContext } from '../match-context/index.js';
import { canonicalizeCs2MapName } from '../map-name.js';

export interface BpProjection {
  readonly matchId: string;
  readonly competition: string;
  readonly stage: string;
  readonly format: 'bo1' | 'bo3' | 'bo5';
  readonly entrants: { readonly a: BpEntrant; readonly b: BpEntrant };
  readonly cards: readonly BpCard[];
  readonly steps: readonly BpStep[];
}
export interface BpEntrant {
  readonly entryId: string;
  readonly name: string;
  readonly logoUrl: string | null;
}
export interface BpSideChoice {
  readonly entrant: 'a' | 'b';
  readonly side: 'CT' | 'T';
}
export interface BpCard {
  readonly mapName: string;
  readonly kind: 'ban' | 'pick' | 'decider';
  readonly entrant: 'a' | 'b' | null;
  readonly sideChoice: BpSideChoice | null;
}
export interface BpStep {
  readonly cardIndex: number;
  readonly kind: 'card' | 'side-choice';
}
export type BpProjectionReadiness = 'ready' | 'incomplete' | 'conflict';
export interface BpProjectionResult {
  readonly readiness: BpProjectionReadiness;
  readonly projection: BpProjection | null;
}

const opposite = (side: 'CT' | 'T') => (side === 'CT' ? 'T' : 'CT');
const mapKey = (name: string) => canonicalizeCs2MapName(name) ?? name.trim().toLowerCase();

interface SideEvidence {
  readonly explicit: BpSideChoice[];
  readonly legacy: BpSideChoice[];
}

/** Normalize current legacy embedded sides and explicit SIDE_PICK to one on-air fact. */
export function inspectBp(context: MatchContext | undefined): BpProjectionResult {
  if (!context) return { readiness: 'incomplete', projection: null };
  if (context.veto.length === 0) return { readiness: 'incomplete', projection: null };
  if (
    context.veto.length > 32 ||
    context.entrants.a.entryId === context.entrants.b.entryId ||
    new Set(context.maps.map((map) => mapKey(map.mapName))).size !== context.maps.length
  )
    return { readiness: 'conflict', projection: null };

  const entrantFor = (id: string | null) =>
    id === context.entrants.a.entryId
      ? ('a' as const)
      : id === context.entrants.b.entryId
        ? ('b' as const)
        : null;
  const ordered = [...context.veto].sort((a, b) => a.stepOrder - b.stepOrder);
  if (new Set(ordered.map((step) => step.stepOrder)).size !== ordered.length)
    return { readiness: 'conflict', projection: null };

  const cards: BpCard[] = [];
  const cardIndexByMap = new Map<string, number>();
  const evidence = new Map<number, SideEvidence>();
  const explicitStepIndex = new Map<number, number>();

  for (const [orderedIndex, step] of ordered.entries()) {
    const name = mapKey(step.mapName);
    if (step.actionType === 'side_pick') {
      const index = cardIndexByMap.get(name);
      const actor = entrantFor(step.entryId);
      const previous = ordered[orderedIndex - 1];
      if (
        index === undefined ||
        cards[index]?.kind === 'ban' ||
        (cards[index]?.kind === 'decider' && context.format === 'bo5') ||
        actor === null ||
        step.side === null ||
        previous === undefined ||
        previous.actionType === 'side_pick' ||
        mapKey(previous.mapName) !== name ||
        explicitStepIndex.has(index)
      )
        return { readiness: 'conflict', projection: null };
      const cardEvidence = evidence.get(index) ?? { explicit: [], legacy: [] };
      cardEvidence.explicit.push({ entrant: actor, side: step.side });
      evidence.set(index, cardEvidence);
      explicitStepIndex.set(index, orderedIndex);
      continue;
    }

    if (cards.length >= 7 || cardIndexByMap.has(name))
      return { readiness: 'conflict', projection: null };
    if (step.actionType === 'ban' && step.side !== null)
      return { readiness: 'conflict', projection: null };
    const owner = step.actionType === 'decider' ? null : entrantFor(step.entryId);
    if (step.actionType !== 'decider' && owner === null)
      return { readiness: 'conflict', projection: null };

    const index = cards.length;
    cardIndexByMap.set(name, index);
    cards.push({ mapName: name, kind: step.actionType, entrant: owner, sideChoice: null });

    if (step.side !== null) {
      const actor =
        step.actionType === 'pick'
          ? owner === 'a'
            ? 'b'
            : owner === 'b'
              ? 'a'
              : null
          : step.actionType === 'decider'
            ? entrantFor(step.entryId)
            : null;
      if (actor === null) return { readiness: 'conflict', projection: null };
      const cardEvidence = evidence.get(index) ?? { explicit: [], legacy: [] };
      cardEvidence.legacy.push({ entrant: actor, side: step.side });
      evidence.set(index, cardEvidence);
    } else if (step.actionType === 'decider' && step.entryId !== null) {
      // Legacy deciders identify the side chooser in entryId. Without a side it
      // is incomplete evidence and must not be converted into an on-air choice.
    }
  }

  const expectedKinds: Readonly<Record<MatchContext['format'], readonly BpCard['kind'][]>> = {
    bo1: [...Array<BpCard['kind']>(6).fill('ban'), 'decider'],
    bo3: ['ban', 'ban', 'pick', 'pick', 'ban', 'ban', 'decider'],
    bo5: ['ban', 'ban', 'pick', 'pick', 'pick', 'pick', 'decider'],
  };
  const expected = expectedKinds[context.format];
  if (cards.length < expected.length) return { readiness: 'incomplete', projection: null };
  if (
    cards.length !== expected.length ||
    cards.some((card, index) => card.kind !== expected[index])
  )
    return { readiness: 'conflict', projection: null };

  const mapByName = new Map(context.maps.map((map) => [mapKey(map.mapName), map]));
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]!;
    const cardEvidence = evidence.get(index) ?? { explicit: [], legacy: [] };
    if (cardEvidence.explicit.length > 1 || cardEvidence.legacy.length > 1)
      return { readiness: 'conflict', projection: null };
    const explicit = cardEvidence.explicit[0];
    const legacy = cardEvidence.legacy[0];
    if (
      explicit !== undefined &&
      legacy !== undefined &&
      (explicit.entrant !== legacy.entrant || explicit.side !== legacy.side)
    )
      return { readiness: 'conflict', projection: null };
    const choice = explicit ?? legacy ?? null;
    if (context.format === 'bo5' && card.kind === 'decider' && choice !== null)
      return { readiness: 'conflict', projection: null };
    const map = mapByName.get(card.mapName);
    if (choice !== null && map?.teamAStartSide !== null && map?.teamAStartSide !== undefined) {
      const expectedTeamA = choice.entrant === 'a' ? choice.side : opposite(choice.side);
      if (expectedTeamA !== map.teamAStartSide) return { readiness: 'conflict', projection: null };
    }
    cards[index] = { ...card, sideChoice: choice };
  }

  const steps: BpStep[] = [];
  for (const [orderedIndex, step] of ordered.entries()) {
    if (step.actionType === 'side_pick') {
      const index = cardIndexByMap.get(mapKey(step.mapName));
      if (index === undefined) return { readiness: 'conflict', projection: null };
      steps.push({ cardIndex: index, kind: 'side-choice' });
      continue;
    }
    const index = cardIndexByMap.get(mapKey(step.mapName));
    if (index === undefined) return { readiness: 'conflict', projection: null };
    steps.push({ cardIndex: index, kind: 'card' });
    const evidenceForCard = evidence.get(index);
    if (
      evidenceForCard?.legacy.length === 1 &&
      !explicitStepIndex.has(index) &&
      explicitStepIndex.get(index) !== orderedIndex
    ) {
      steps.push({ cardIndex: index, kind: 'side-choice' });
    }
  }

  const team = (key: 'a' | 'b'): BpEntrant => {
    const { entryId, name, logoUrl } = context.entrants[key];
    return { entryId, name, logoUrl };
  };
  return {
    readiness: 'ready',
    projection: {
      matchId: context.matchId,
      competition: context.competition.name,
      stage: context.stage,
      format: context.format,
      entrants: { a: team('a'), b: team('b') },
      cards,
      steps,
    },
  };
}

/** Finite, Program-safe presentation derived from the canonical MatchContext. */
export function projectBp(context: MatchContext | undefined): BpProjection | null {
  return inspectBp(context).projection;
}
