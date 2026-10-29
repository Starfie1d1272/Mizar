import type { ProgramPayload } from '@mizar/protocol/program';

export function lhmContext(program: ProgramPayload) {
  const series = program.series;
  const ct = program.teams.ct;
  const t = program.teams.t;
  if (
    program.status.context !== 'fresh' ||
    program.status.identity !== 'matched' ||
    !program.match ||
    !series ||
    ct.mode !== 'canonical' ||
    t.mode !== 'canonical' ||
    series.score.a === null ||
    series.score.b === null
  )
    return null;
  const entries = [series.entrants.a, series.entrants.b];
  if (
    !entries.some((entry) => entry.entryId === ct.entryId) ||
    !entries.some((entry) => entry.entryId === t.entryId) ||
    ct.entryId === t.entryId
  )
    return null;
  const ctSlot = program.players.find(
    (player) => player.side === 'CT' && player.observerSlot !== null,
  )?.observerSlot;
  const tSlot = program.players.find(
    (player) => player.side === 'T' && player.observerSlot !== null,
  )?.observerSlot;
  if (ctSlot == null || tSlot == null) return null;
  // Match the fixed template's csgogsi orientation rule, including slot zero.
  const left = (ctSlot || 10) > (tSlot || 10) ? t : ct;
  const right = left === ct ? t : ct;
  const score = (id: string) =>
    id === series.entrants.a.entryId ? series.score.a : series.score.b;
  const vetos = series.veto
    .filter((step) => step.actionType !== 'side_pick')
    .map((step) => {
      const map = series.maps.find((candidate) => candidate.mapName === step.mapName);
      return {
        mapName: step.mapName,
        type: step.actionType,
        teamId: step.entryId,
        ...(step.side ? { side: step.side } : {}),
        ...(map ? { mapEnd: map.status === 'completed' } : {}),
        ...(map?.winnerEntryId ? { winner: map.winnerEntryId } : {}),
        ...(map?.finalScore
          ? {
              score: {
                [series.entrants.a.entryId]: map.finalScore.a,
                [series.entrants.b.entryId]: map.finalScore.b,
              },
            }
          : {}),
      };
    });
  return {
    match: {
      id: program.match.matchId,
      current: true,
      left: { id: left.entryId, wins: score(left.entryId) },
      right: { id: right.entryId, wins: score(right.entryId) },
      matchType: series.format,
      vetos,
    },
    teams: entries.map((entry) => ({
      _id: entry.entryId,
      name: entry.name,
      logo: entry.logoUrl?.startsWith('/local/v1/local-assets/') ? true : null,
      country: null,
      extra: {},
    })),
    logos: new Map(entries.map((entry) => [entry.entryId, entry.logoUrl])),
  };
}
