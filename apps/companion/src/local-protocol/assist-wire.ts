import type { AssistPayload } from '@mizar/protocol/assist';
import type { ObserverAssistProjection } from '@mizar/core/projection';

export function mapObserverAssistProjection(projection: ObserverAssistProjection): AssistPayload {
  return {
    availability: projection.availability,
    ...(projection.observer
      ? {
          observer: {
            state: projection.observer.state,
            waitingReason: projection.observer.waitingReason,
            nextWindowSeconds: projection.observer.nextWindowSeconds,
            leadSeconds: projection.observer.leadSeconds,
            hints: projection.observer.hints.map((hint) => ({ ...hint })),
          },
        }
      : {}),
  };
}
