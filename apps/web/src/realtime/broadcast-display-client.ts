import { useEffect, useState } from 'react';
import { parseBroadcastDisplayConfig, type BroadcastDisplayConfig } from '@mizar/broadcast-config';

export interface BroadcastDisplayClientState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly current: BroadcastDisplayConfig | null;
}

/** Poll an atomic display projection; retain the last complete value across transient failures. */
export function useBroadcastDisplayConfig(enabled = true): BroadcastDisplayClientState {
  const [value, setValue] = useState<BroadcastDisplayClientState>({
    status: 'loading',
    current: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/local/v1/broadcast-display-config', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error('display configuration unavailable');
        const current = parseBroadcastDisplayConfig(await response.json());
        if (active) setValue({ status: 'ready', current });
      } catch {
        if (active) setValue((previous) => ({ status: 'unavailable', current: previous.current }));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled]);
  return value;
}
