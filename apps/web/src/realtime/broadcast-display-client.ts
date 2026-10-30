import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { pulseBackgroundUrl, supportsBroadcastDisplay } from '../program/broadcast-display';
import { useEffect, useState } from 'react';
import {
  fallbackHudPauseVisual,
  parseBroadcastDisplayConfig,
  type BroadcastDisplayConfig,
} from '@mizar/broadcast-config';

export interface BroadcastDisplayClientState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'unsupported';
  readonly current: BroadcastDisplayConfig | null;
  readonly reason?: string | null;
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
    let verifiedBackground: string | null = null;
    const poll = async () => {
      let failureReason = 'display_unavailable';
      try {
        const response = await fetch('/local/v1/broadcast-display-config', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error('display configuration unavailable');
        if (
          scene !== 'gameplay' &&
          response.headers?.get('x-mizar-program-status') === 'dependency_missing'
        )
          throw new Error('scene dependency unavailable');
        failureReason = 'invalid_display_config';
        const parsed = parseBroadcastDisplayConfig(await response.json());
        failureReason = 'display_dependency_unavailable';
        const fallback = fallbackHudPauseVisual(parsed.hud);
        const current = { ...parsed, hud: fallback.hud };
        const reason = fallback.reason ?? response.headers?.get('x-mizar-hud-fallback') ?? null;
        if (!supportsBroadcastDisplay(current, scene)) {
          if (active)
            setValue((previous) =>
              previous.status === 'unsupported'
                ? previous
                : {
                    status: 'unsupported',
                    current: previous.current,
                    reason: 'unsupported_renderer_or_scene',
                  },
            );
          return;
        }
        const background = scene === 'gameplay' ? null : pulseBackgroundUrl(current.program);
        if (background && background !== verifiedBackground) {
          const image = await fetch(background, { signal: AbortSignal.timeout(2000) });
          if (!image.ok || !image.headers.get('content-type')?.startsWith('image/'))
            throw new Error('background unavailable');
          verifiedBackground = background;
        }
        if (active)
          setValue((previous) =>
            previous.status === 'ready' &&
            previous.current?.activeRevision === current.activeRevision &&
            previous.reason === reason
              ? previous
              : { status: 'ready', current, reason },
          );
      } catch {
        if (active)
          setValue((previous) =>
            previous.status === 'unsupported' ||
            (previous.status === 'unavailable' && previous.reason === failureReason)
              ? previous
              : { status: 'unavailable', current: previous.current, reason: failureReason },
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
