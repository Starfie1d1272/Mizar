import type { BpSnapshot } from '@mizar/protocol/bp';

const maps = ['ancient', 'anubis', 'inferno', 'nuke', 'mirage', 'dust2', 'vertigo'];
const kinds = ['ban', 'ban', 'pick', 'pick', 'ban', 'ban', 'decider'] as const;
const cards = maps.map((map, index) => ({
  mapName: `de_${map}`,
  kind: kinds[index]!,
  entrant: index === 6 ? null : index % 2 ? ('b' as const) : ('a' as const),
  sideChoice: null,
}));
export const bpPreviewSnapshot: BpSnapshot = {
  schemaVersion: 'mizar.bp.v2',
  revision: 'preview',
  state: 'shown',
  revealedCount: 7,
  projection: {
    competition: '示例赛事',
    stage: '示例',
    format: 'bo3',
    entrants: {
      a: { name: '示例战队 A', logoUrl: null },
      b: { name: '示例战队 B', logoUrl: null },
    },
    cards,
    steps: cards.map((_, index) => ({ cardIndex: index, kind: 'card' as const })),
  },
};
