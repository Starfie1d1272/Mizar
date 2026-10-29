import type { AssistPayload } from '@mizar/protocol/assist';
import type { ObserverAssistProjection } from '@mizar/core/projection';

export function mapObserverAssistProjection(projection: ObserverAssistProjection): AssistPayload {
  return {
    availability: projection.availability,
    ...(projection.observer
      ? {
          observer: {
            state: projection.observer.state,
            timingBasis: projection.observer.timingBasis,
            calibrationState: projection.observer.calibrationState,
            effectiveDelaySeconds: projection.observer.effectiveDelaySeconds,
            waitingReason: projection.observer.waitingReason,
            nextWindowSeconds: projection.observer.nextWindowSeconds,
            leadSeconds: projection.observer.leadSeconds,
            measuredDelaySeconds: projection.observer.measuredDelaySeconds,
            hints: projection.observer.hints.map((hint) => ({ ...hint })),
          },
        }
      : {}),
  };
}
