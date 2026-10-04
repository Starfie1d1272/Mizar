import type { ProgramPayload } from '@mizar/protocol/program';
import type {
  MatchHeaderRoundHistoryPresentation,
  MatchHeaderRoundPresentation,
} from './presentation';

export const ROUND_HISTORY_LABELS = {
  elimination: 'ELIMINATION',
  bomb: 'BOMB EXPLODED',
  defuse: 'BOMB DEFUSED',
  time: 'TIME EXPIRED',
  unknown: 'UNKNOWN',
} as const;

export interface HistorySlot {
  readonly roundNumber: number;
  readonly result: MatchHeaderRoundPresentation | null;
}

/** Show the most recently played half/OT, never recolor it using current team sides. */
export function roundHistorySegment(history: MatchHeaderRoundHistoryPresentation) {
  const last = history.rounds.at(-1)?.roundNumber ?? 1;
  const start = last <= 24 ? (last <= 12 ? 1 : 13) : 25 + Math.floor((last - 25) / 6) * 6;
  const count = start <= 24 ? 12 : 6;
  const byNumber = new Map(history.rounds.map((round) => [round.roundNumber, round]));
  return {
    label:
      start === 1
        ? '1ST HALF'
        : start === 13
          ? '2ND HALF'
          : `OT ${Math.floor((start - 25) / 6) + 1}`,
    slots: Array.from({ length: count }, (_, index): HistorySlot => ({
      roundNumber: start + index,
      result: byNumber.get(start + index) ?? null,
    })),
  };
}

export function freezeHistoryEligible(payload: ProgramPayload): boolean {
  const history = payload.series?.roundHistory;
  const last = history?.rounds.at(-1)?.roundNumber ?? 0;
  return (
    payload.status.telemetry === 'fresh' &&
    payload.clock?.phase === 'freezetime' &&
    history != null &&
    history.completeness !== 'unavailable' &&
    last > 0 &&
    last % 3 === 0 &&
    payload.map.roundNumber === last &&
    (payload.clock.endsInSeconds ?? 0) > 3
  );
}
