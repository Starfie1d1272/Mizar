import { useMemo, useSyncExternalStore } from 'react';
import type { LocalChannelClient } from '../realtime';
import { hasRadarViewFrame } from '../program/widgets/radar/adapter';

export type RadarAvailabilitySource = Pick<
  LocalChannelClient<'radar'>,
  'subscribe' | 'getSnapshot'
>;

/** React observes availability; Radar's imperative subscriber still receives every sample. */
export function useRadarAvailability(client: RadarAvailabilitySource): boolean {
  const getAvailability = useMemo(
    () => () => {
      const state = client.getSnapshot();
      return hasRadarViewFrame(state.state === 'live' ? state.current : null);
    },
    [client],
  );
  return useSyncExternalStore(client.subscribe, getAvailability, getAvailability);
}
