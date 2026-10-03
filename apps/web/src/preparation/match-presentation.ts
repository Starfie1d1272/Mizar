import type { MatchDocumentV1 } from '@mizar/protocol/context';

type Veto = MatchDocumentV1['veto'][number];
export const mapLabel = (name: string) => name.replace(/^de_/, '').toUpperCase();
const mapKey = (name: string) => name.replace(/^de_/, '').toLowerCase();
const opposite = (side: 'CT' | 'T') => (side === 'CT' ? 'T' : 'CT');

export function matchRound(
  match: Pick<MatchDocumentV1, 'roundLabel' | 'round' | 'entryRound'>,
): string | null {
  return (
    match.roundLabel?.trim() ||
    (match.round !== null ? `第 ${match.round} 轮` : match.entryRound?.trim() || null)
  );
}

/** Legacy PICK.side belongs to the opponent; SIDE_PICK and DECIDER name the chooser. */
export function sideChoice(match: Pick<MatchDocumentV1, 'entrants'>, step: Veto) {
  if (!step.side || step.actionType === 'ban') return null;
  const actor =
    step.entryId === match.entrants.a.entryId
      ? 'a'
      : step.entryId === match.entrants.b.entryId
        ? 'b'
        : null;
  if (!actor) return null;
  const entrant = step.actionType === 'pick' ? (actor === 'a' ? 'b' : 'a') : actor;
  return {
    entrant,
    name: match.entrants[entrant].name,
    side: step.side,
    teamA: entrant === 'a' ? step.side : opposite(step.side),
  };
}

export function matchMaps(match: Pick<MatchDocumentV1, 'maps' | 'veto' | 'entrants'>) {
  const selected = [...match.veto]
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .filter((s) => s.actionType === 'pick' || s.actionType === 'decider');
  const names = [
    ...new Set(
      [...match.maps]
        .sort((a, b) => a.mapOrder - b.mapOrder)
        .map((m) => mapKey(m.mapName))
        .concat(selected.map((s) => mapKey(s.mapName))),
    ),
  ];
  return names
    .map((name) => {
      const map = match.maps.find((m) => mapKey(m.mapName) === name);
      const selection = selected.find((s) => mapKey(s.mapName) === name);
      const choices = match.veto
        .filter((s) => mapKey(s.mapName) === name)
        .map((s) => sideChoice(match, s))
        .filter((c) => c !== null);
      const sides = new Set([
        ...(map?.teamAStartSide ? [map.teamAStartSide] : []),
        ...choices.map((c) => c.teamA),
      ]);
      const conflict = sides.size > 1;
      const startA = conflict ? null : ([...sides][0] ?? null);
      const picker =
        map?.pickedByEntryId ?? (selection?.actionType === 'pick' ? selection.entryId : null);
      return {
        name: map?.mapName ?? selection!.mapName,
        order: map?.mapOrder ?? selected.findIndex((s) => s === selection) + 1,
        selection:
          selection?.actionType === 'decider'
            ? '决胜图'
            : picker
              ? `${Object.values(match.entrants).find((t) => t.entryId === picker)?.name ?? '队伍待确认'} 选图`
              : '选图待确认',
        score:
          map && map.scoreA !== null && map.scoreB !== null
            ? `${map.scoreA} : ${map.scoreB}`
            : null,
        startA,
        startB: startA ? opposite(startA) : null,
        conflict,
      };
    })
    .sort((a, b) => a.order - b.order);
}
