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
  enabled = true,
): LocalChannelClient<C> {
  const client = useMemo(
    () => (enabled ? createLocalChannelClient(channel) : createLocalChannelClient(channel)),
    [channel, enabled],
  );
  const pendingDisposal = useRef<{ client: LocalChannelClient<C>; timer: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (pendingDisposal.current?.client === client) {
      window.clearTimeout(pendingDisposal.current.timer);
      pendingDisposal.current = null;
    }
    client.start();
    return () => {
      const timer = window.setTimeout(() => {
        if (pendingDisposal.current?.client === client) {
          pendingDisposal.current = null;
        }
        client.dispose();
      }, 0);
      pendingDisposal.current = { client, timer };
    };
  }, [client, enabled]);

  return client;
}
