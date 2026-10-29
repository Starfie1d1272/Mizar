import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { supportsBroadcastDisplay } from '../program/broadcast-display';
import { useEffect, useState } from 'react';
import { parseBroadcastDisplayConfig, type BroadcastDisplayConfig } from '@mizar/broadcast-config';

export interface BroadcastDisplayClientState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'unsupported';
  readonly current: BroadcastDisplayConfig | null;
}

/** Poll an atomic display projection; retain the last complete value across transient failures. */
export function useBroadcastDisplayConfig(
  enabled = true,
  scene: ProgramSceneId = 'gameplay',
): BroadcastDisplayClientState {
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
        if (!supportsBroadcastDisplay(current, scene)) {
          if (active)
            setValue((previous) => ({ status: 'unsupported', current: previous.current }));
          return;
        }
        if (active)
          setValue((previous) =>
            previous.status === 'ready' &&
            previous.current?.activeRevision === current.activeRevision
              ? previous
              : { status: 'ready', current },
          );
      } catch {
        if (active)
          setValue((previous) =>
            previous.status === 'unsupported'
              ? previous
              : { status: 'unavailable', current: previous.current },
          );
      } finally {
        if (active) timer = setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, scene]);
  return value;
}
