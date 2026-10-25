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
            waitingReason: projection.observer.waitingReason,
            nextWindowSeconds: projection.observer.nextWindowSeconds,
            expectedDelaySeconds: projection.observer.expectedDelaySeconds,
            leadSeconds: projection.observer.leadSeconds,
            measuredDelaySeconds: projection.observer.measuredDelaySeconds,
            hints: projection.observer.hints.map((hint) => ({ ...hint })),
          },
        }
      : {}),
  };
}
