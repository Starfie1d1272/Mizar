import {
  BROADCAST_MANIFEST_SCHEMA_VERSION,
  type BroadcastManifestV1,
  type BroadcastVetoStepV1,
} from '../manifest/types.js';
export type BpDemoFormat = 'bo1' | 'bo3' | 'bo5';

function manifest(format: BpDemoFormat, veto: readonly BroadcastVetoStepV1[]): BroadcastManifestV1 {
  const real = format === 'bo3';
  const a = real ? 'epl-falcons' : 'demo-a';
  const b = real ? 'epl-navi' : 'demo-b';
  return {
    schemaVersion: BROADCAST_MANIFEST_SCHEMA_VERSION,
    revision: `bp-demo-${format}-epl-v1`,
    match: {
      matchId: real ? 'hltv-2398745' : `format-example-${format}`,
      competition: real
        ? {
            competitionId: 'hltv-event-8244',
            slug: 'epl-s24',
            name: 'ESL Pro League Season 24',
            themeColor: null,
          }
        : {
            competitionId: 'format-example',
            slug: 'format-example',
            name: '赛制演示（合成）',
            themeColor: null,
          },
      status: 'scheduled',
      format,
      stage: real ? '瑞士轮 · 第4轮 · 2–1组' : '赛制边界示例',
      round: real ? 4 : null,
      entryRound: real ? '2–1 组' : null,
      scheduledAt: real ? '2026-10-06T19:00:00.000Z' : null,
      startedAt: null,
      completedAt: null,
      scoreA: null,
      scoreB: null,
      isForfeit: false,
    },
    entrants: {
      a: {
        entryId: a,
        name: real ? 'Falcons' : '示例队伍 A',
        logoUrl: real
          ? 'https://img-cdn.hltv.org/teamlogo/4eJSkDQINNM6Tbs4WvLzkN.png?ixlib=java-2.1.0&w=200&s=d4dd034c2c7786f7c75e51a3a3aa7b5c'
          : null,
        roster: { rosterId: null, players: [] },
      },
      b: {
        entryId: b,
        name: real ? 'Natus Vincere' : '示例队伍 B',
        logoUrl: real
          ? 'https://img-cdn.hltv.org/teamlogo/9iMirAi7ArBLNU8p3kqUTZ.svg?ixlib=java-2.1.0&s=4dd8635be16122656093ae9884675d0c'
          : null,
        roster: { rosterId: null, players: [] },
      },
    },
    maps: veto
      .filter((step) => step.actionType === 'pick' || step.actionType === 'decider')
      .map((step, index) => {
        const side = veto.find(
          (candidate) => candidate.mapName === step.mapName && candidate.actionType === 'side_pick',
        );
        return {
          mapId: `bp-demo-${format}-${index + 1}`,
          mapOrder: index + 1,
          mapName: step.mapName,
          pickedByEntryId: step.actionType === 'pick' ? step.entryId : null,
          teamAStartSide:
            side?.side == null
              ? null
              : side.entryId === a
                ? side.side
                : side.side === 'ct'
                  ? 't'
                  : 'ct',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        };
      }),
    veto,
    commentators: [],
  };
}
type Step = Omit<BroadcastVetoStepV1, 'stepOrder'>;
const step = (
  actionType: Step['actionType'],
  mapName: string,
  entryId: string | null,
  side: Step['side'] = null,
): Step => ({ actionType, mapName, entryId, side });
const numbered = (steps: readonly Step[]): BroadcastVetoStepV1[] =>
  steps.map((item, index) => ({ ...item, stepOrder: index + 1 }));
// Source and timezone evidence: fixtures/epl-s24/source.json (HLTV 2398745).
const epl = numbered([
  step('ban', 'de_dust2', 'epl-navi'),
  step('ban', 'de_cache', 'epl-falcons'),
  step('pick', 'de_inferno', 'epl-navi'),
  step('side_pick', 'de_inferno', 'epl-falcons', 'ct'),
  step('pick', 'de_anubis', 'epl-falcons'),
  step('side_pick', 'de_anubis', 'epl-navi', 't'),
  step('ban', 'de_ancient', 'epl-navi'),
  step('ban', 'de_nuke', 'epl-falcons'),
  step('decider', 'de_mirage', null),
]);
const bo1 = numbered([
  ...['de_dust2', 'de_cache', 'de_ancient', 'de_nuke', 'de_anubis', 'de_mirage'].map((map, index) =>
    step('ban', map, index % 2 ? 'demo-b' : 'demo-a'),
  ),
  step('decider', 'de_inferno', null),
  step('side_pick', 'de_inferno', 'demo-b', 't'),
]);
const bo5 = numbered([
  step('ban', 'de_dust2', 'demo-a'),
  step('ban', 'de_cache', 'demo-b'),
  ...['de_inferno', 'de_anubis', 'de_ancient', 'de_nuke'].flatMap((map, index) => [
    step('pick', map, index % 2 ? 'demo-b' : 'demo-a'),
    step('side_pick', map, index % 2 ? 'demo-a' : 'demo-b', index % 2 ? 'ct' : 't'),
  ]),
  step('decider', 'de_mirage', null),
]);
const BP_DEMO_MANIFESTS: Readonly<Record<BpDemoFormat, BroadcastManifestV1>> = {
  bo1: manifest('bo1', bo1),
  bo3: manifest('bo3', epl),
  bo5: manifest('bo5', bo5),
};
export function getBpDemoManifest(format: BpDemoFormat): BroadcastManifestV1 {
  return BP_DEMO_MANIFESTS[format];
}
