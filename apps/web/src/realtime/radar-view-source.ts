import { useMemo } from 'react';
import type { RadarViewSource } from '@mizar-hud/radar-view';
import type { LocalChannelClient } from './index';
import { toRadarViewFrame } from '../program/widgets/radar/adapter';

function createRadarViewSource(client: LocalChannelClient<'radar'>): RadarViewSource {
  let last: ReturnType<typeof client.getSnapshot> | undefined;
  let frame: ReturnType<typeof toRadarViewFrame> = null;
  return {
    subscribe: (listener) => client.subscribe(listener),
    getSnapshot: () => {
      const state = client.getSnapshot();
      if (state !== last) {
        last = state;
        frame = toRadarViewFrame(state.state === 'live' ? state.current : null);
      }
      return frame;
    },
  };
}

/** Adapt the local channel at the host boundary; views consume only radar frames. */
export function useRadarViewSource(client: LocalChannelClient<'radar'>): RadarViewSource {
  return useMemo(() => createRadarViewSource(client), [client]);
}
