import { RIVALS_BP_RECORDS } from '../../apps/web/src/program/fixtures/rivals-bp-records.js';

/** Real public NJU BP records; missing roster/map IDs stay fixture-local and are not gameplay evidence. */
export function bpManifestFixture(key: keyof typeof RIVALS_BP_RECORDS) {
  const record = RIVALS_BP_RECORDS[key];
  const entrant = (side: 'a' | 'b') => ({
    ...record.entrants[side],
    roster: { rosterId: null, players: [] },
  });
  return {
    schemaVersion: 'rivalhub.broadcast-manifest.v1' as const,
    revision: 'rivals-bp-2026-09-24',
    match: {
      matchId: record.matchId,
      competition: {
        competitionId: 'fixture-nju-rivals',
        slug: '2026-nju-rivals',
        name: '2026 NJU RIVALS',
        themeColor: null,
      },
      status: 'finished' as const,
      format: record.format,
      stage: key === 'final' ? '总决赛' : '胜者组半决赛',
      round: null,
      entryRound: null,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      scoreA: key === 'final' ? 3 : 0,
      scoreB: key === 'final' ? 1 : 2,
      isForfeit: false,
    },
    entrants: { a: entrant('a'), b: entrant('b') },
    maps: record.maps.map((m) => ({
      mapId: `fixture-${record.matchId}-${m.mapOrder}`,
      mapOrder: m.mapOrder,
      mapName: m.mapName,
      pickedByEntryId: m.selection.kind === 'pick' ? m.selection.entryId : null,
      teamAStartSide: m.teamAStartSide?.toLowerCase() ?? null,
      scoreA: m.finalScore?.a ?? null,
      scoreB: m.finalScore?.b ?? null,
      completedAt: null,
    })),
    veto: record.veto.map((v) => ({ ...v, side: v.side?.toLowerCase() ?? null })),
    commentators: [],
  };
}
