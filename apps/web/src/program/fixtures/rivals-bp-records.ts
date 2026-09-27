import type { ProgramPayload } from '@mizar/protocol/program';
import { RIVALS_BP_RECORDS } from './rivals-bp-records.generated.js';

type ProgramSeries = NonNullable<ProgramPayload['series']>;
type RivalsBpRecord = (typeof RIVALS_BP_RECORDS)[keyof typeof RIVALS_BP_RECORDS];

export { RIVALS_BP_RECORDS };

export function rivalsSeriesCut(
  record: RivalsBpRecord,
  currentMapOrder: number | null,
): ProgramSeries {
  const completed = record.maps.filter(
    (map) =>
      map.finalScore !== null && (currentMapOrder === null || map.mapOrder < currentMapOrder),
  );
  const score = {
    a: completed.filter((map) => map.winnerEntryId === record.entrants.a.entryId).length,
    b: completed.filter((map) => map.winnerEntryId === record.entrants.b.entryId).length,
  };
  return {
    format: record.format,
    requiredWins: record.format === 'bo5' ? 3 : 2,
    entrants: record.entrants,
    score,
    status: currentMapOrder === null ? 'completed' : 'live',
    bindingState: 'bound',
    currentMapOrder,
    maps: record.maps.map((map) =>
      currentMapOrder !== null && map.mapOrder >= currentMapOrder
        ? {
            ...map,
            status: map.mapOrder === currentMapOrder ? 'current' : 'pending',
            finalScore: null,
            winnerEntryId: null,
          }
        : map,
    ),
    veto: [...record.veto],
    roundHistory: null,
  };
}
