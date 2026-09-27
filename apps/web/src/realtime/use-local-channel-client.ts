import { useEffect, useMemo, useRef } from 'react';

import type { LocalSnapshotChannel } from '@mizar/protocol/version';

import { createLocalChannelClient, type LocalChannelClient } from './local-channel-client';

/**
 * React StrictMode re-runs effects immediately. Delay disposal by one task so
 * that the development-only cleanup does not permanently close the shared
 * client before the second effect setup starts it again.
 */
export function useLocalChannelClient<C extends LocalSnapshotChannel>(
  channel: C,
): LocalChannelClient<C> {
  const client = useMemo(() => createLocalChannelClient(channel), [channel]);
  const disposeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (disposeTimer.current !== undefined) {
      window.clearTimeout(disposeTimer.current);
      disposeTimer.current = undefined;
    }
    client.start();
    return () => {
      disposeTimer.current = window.setTimeout(() => {
        disposeTimer.current = undefined;
        client.dispose();
      }, 0);
    };
  }, [client]);

  return client;
}
