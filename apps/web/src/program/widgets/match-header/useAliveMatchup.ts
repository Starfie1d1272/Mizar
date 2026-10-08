import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectionCursor } from '@mizar/protocol/shared';
import { consecutivePresentationSamples } from '../../presentation-sample';

export const ALIVE_MATCHUP_HOLD_MS = 4500;

/** Counts are accepted truth. This hook only owns the short presentation window. */
export function useAliveMatchup(sample: string | null, cursor: ProjectionCursor): string | null {
  const previous = useRef<{ sample: string | null; cursor: ProjectionCursor } | null>(null);
  const timer = useRef<number | null>(null);
  const [visible, setVisible] = useState<string | null>(null);
  useLayoutEffect(() => {
    const prior = previous.current;
    previous.current = { sample, cursor };
    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setVisible(null);
    };
    if (sample === null || prior?.sample == null) {
      clear();
      return;
    }
    if (prior.cursor === cursor && prior.sample === sample) return;
    if (!consecutivePresentationSamples(prior.cursor, cursor)) {
      // Runtime-only publications need not represent a new telemetry sample.
      if (
        prior.sample === sample &&
        prior.cursor.producerInstanceId === cursor.producerInstanceId &&
        prior.cursor.liveSessionId === cursor.liveSessionId &&
        prior.cursor.programSourceGeneration === cursor.programSourceGeneration &&
        prior.cursor.mapEpoch === cursor.mapEpoch &&
        (prior.cursor.programReceiveSequence ?? prior.cursor.runtimeSeq) ===
          (cursor.programReceiveSequence ?? cursor.runtimeSeq)
      )
        return;
      clear();
      return;
    }
    const before = prior.sample.split('v').map(Number);
    const after = sample.split('v').map(Number);
    if (after.some((count, index) => count > before[index]!)) {
      clear();
      return;
    }
    if (!after.some((count, index) => count < before[index]!)) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setVisible(sample);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setVisible(null);
    }, ALIVE_MATCHUP_HOLD_MS);
  }, [sample, cursor]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return visible;
}
