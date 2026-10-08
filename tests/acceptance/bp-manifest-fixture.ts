import base from '../../packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json' with { type: 'json' };
import { RIVALS_BP_RECORDS } from '../../packages/rivalhub/src/demo/rivals-bp-records.js';

// Historical side-choice coverage must not follow the product's current demo selection.
export function bpManifestFixture(key: 'semifinalA' | 'final') {
  const record = RIVALS_BP_RECORDS[key];
  const side = (value: 'CT' | 'T' | null) => (value === null ? null : value === 'CT' ? 'ct' : 't');
  return {
    ...structuredClone(base),
    revision: `acceptance-${record.matchId}`,
    match: {
      ...base.match,
      matchId: record.matchId,
      format: record.format,
      competition: {
        competitionId: '2026-nju-rivals',
        slug: '2026-nju-rivals',
        name: '2026 NJU Rivals',
        themeColor: '#f97316',
      },
    },
    entrants: {
      a: { ...record.entrants.a, roster: { rosterId: null, players: [] } },
      b: { ...record.entrants.b, roster: { rosterId: null, players: [] } },
    },
    maps: record.maps.map((map) => ({
      mapId: `acceptance-${record.matchId}-${map.mapOrder}`,
      mapOrder: map.mapOrder,
      mapName: map.mapName,
      pickedByEntryId: map.selection.kind === 'pick' ? map.selection.entryId : null,
      teamAStartSide: side(map.teamAStartSide),
      scoreA: null,
      scoreB: null,
      completedAt: null,
    })),
    veto: record.veto.map((step) => ({ ...step, side: side(step.side) })),
    commentators: [],
  };
}
