import { BROADCAST_MANIFEST_SCHEMA_VERSION, type BroadcastManifestV1 } from '../manifest/types.js';
import { RIVALS_BP_RECORDS, type RivalsBpRecord } from './rivals-bp-records.js';

export type BpDemoFormat = 'bo1' | 'bo3' | 'bo5';

const COMPETITION = {
  competitionId: '2026-nju-rivals',
  slug: '2026-nju-rivals',
  name: '2026 NJU Rivals',
  themeColor: '#f97316',
} as const;

function toSide(side: 'CT' | 'T' | null): 'ct' | 't' | null {
  return side === null ? null : side.toLowerCase() === 'ct' ? 'ct' : 't';
}

function seriesScore(record: RivalsBpRecord) {
  const completedMaps = record.maps.filter((map) => map.finalScore !== null);
  return {
    a: completedMaps.filter((map) => map.winnerEntryId === record.entrants.a.entryId).length,
    b: completedMaps.filter((map) => map.winnerEntryId === record.entrants.b.entryId).length,
  };
}

function manifestFromRecord(record: RivalsBpRecord, stage: string): BroadcastManifestV1 {
  const score = seriesScore(record);
  return {
    schemaVersion: BROADCAST_MANIFEST_SCHEMA_VERSION,
    revision: `bp-demo-${record.format}-2026-nju-rivals`,
    match: {
      matchId: record.matchId,
      competition: COMPETITION,
      status: 'finished',
      format: record.format,
      stage,
      round: null,
      entryRound: null,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      scoreA: score.a,
      scoreB: score.b,
      isForfeit: false,
    },
    entrants: {
      a: {
        ...record.entrants.a,
        roster: { rosterId: null, players: [] },
      },
      b: {
        ...record.entrants.b,
        roster: { rosterId: null, players: [] },
      },
    },
    maps: record.maps.map((map) => ({
      mapId: `bp-demo-${record.matchId}-${map.mapOrder}`,
      mapOrder: map.mapOrder,
      mapName: map.mapName,
      pickedByEntryId: map.selection.kind === 'pick' ? map.selection.entryId : null,
      teamAStartSide: toSide(map.teamAStartSide),
      scoreA: map.finalScore?.a ?? null,
      scoreB: map.finalScore?.b ?? null,
      completedAt: null,
    })),
    // Keep the historical DECIDER actor and side intact. inspectBp owns the
    // compatibility normalization into the single on-air side-choice fact.
    veto: record.veto.map((step) => ({
      ...step,
      side: toSide(step.side),
    })),
    commentators: [],
  };
}

const bo1Record: RivalsBpRecord = {
  matchId: '9bf56802-1756-43ae-ae3a-c468d0237edc',
  format: 'bo1',
  entrants: RIVALS_BP_RECORDS.semifinalB.entrants,
  maps: [
    {
      mapId: null,
      mapOrder: 1,
      mapName: 'de_ancient',
      selection: { kind: 'decider' },
      teamAStartSide: 'CT',
      status: 'completed',
      finalScore: { a: 3, b: 13 },
      winnerEntryId: RIVALS_BP_RECORDS.semifinalB.entrants.b.entryId,
    },
  ],
  veto: [
    {
      stepOrder: 1,
      actionType: 'ban',
      mapName: 'de_inferno',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.a.entryId,
      side: null,
    },
    {
      stepOrder: 2,
      actionType: 'ban',
      mapName: 'de_anubis',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.a.entryId,
      side: null,
    },
    {
      stepOrder: 3,
      actionType: 'ban',
      mapName: 'de_dust2',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.b.entryId,
      side: null,
    },
    {
      stepOrder: 4,
      actionType: 'ban',
      mapName: 'de_nuke',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.b.entryId,
      side: null,
    },
    {
      stepOrder: 5,
      actionType: 'ban',
      mapName: 'de_overpass',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.b.entryId,
      side: null,
    },
    {
      stepOrder: 6,
      actionType: 'ban',
      mapName: 'de_mirage',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.a.entryId,
      side: null,
    },
    {
      stepOrder: 7,
      actionType: 'decider',
      mapName: 'de_ancient',
      entryId: RIVALS_BP_RECORDS.semifinalB.entrants.b.entryId,
      side: 'T',
    },
  ],
};

const BP_DEMO_MANIFESTS: Readonly<Record<BpDemoFormat, BroadcastManifestV1>> = {
  bo1: manifestFromRecord(bo1Record, 'qualifier'),
  bo3: manifestFromRecord(RIVALS_BP_RECORDS.semifinalA, '胜者组半决赛'),
  bo5: manifestFromRecord(RIVALS_BP_RECORDS.final, '总决赛'),
};

export function getBpDemoManifest(format: BpDemoFormat): BroadcastManifestV1 {
  return BP_DEMO_MANIFESTS[format];
}
