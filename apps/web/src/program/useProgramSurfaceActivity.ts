import { useEffect, useState } from 'react';
import type { ProgramSceneId, ProgramSceneState } from '@mizar/protocol/program-scenes';

export interface ProgramSurfaceActivityOptions {
  readonly sceneId: ProgramSceneId;
  readonly scenes: ProgramSceneState | null;
  readonly desktop?: boolean;
}

/**
 * Determine whether a program surface should maintain active polling and real-time subscriptions:
 * 1. Desktop transparent overlay: always active (independently gated by desktop overlay policy).
 * 2. OBS scene host: active when the source is active/visible or when the scene is on-air/preparing/next.
 * 3. Standalone browser: active when the page is visible.
 */
export function useProgramSurfaceActivity({
  sceneId,
  scenes,
  desktop = false,
}: ProgramSurfaceActivityOptions): boolean {
  const [docVisible, setDocVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  const [obsState, setObsState] = useState<{ active: boolean | null; visible: boolean | null }>({
    active: null,
    visible: null,
  });

  useEffect(() => {
    const onVisibilityChange = () => {
      setDocVisible(document.visibilityState !== 'hidden');
    };
    const onObsActive = (event: Event) => {
      const active = (event as CustomEvent<{ active?: unknown }>).detail?.active;
      if (typeof active === 'boolean') {
        setObsState((prev) => (prev.active === active ? prev : { ...prev, active }));
      }
    };
    const onObsVisible = (event: Event) => {
      const visible = (event as CustomEvent<{ visible?: unknown }>).detail?.visible;
      if (typeof visible === 'boolean') {
        setObsState((prev) => (prev.visible === visible ? prev : { ...prev, visible }));
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('obsSourceActiveChanged', onObsActive);
      window.addEventListener('obsSourceVisibleChanged', onObsVisible);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('obsSourceActiveChanged', onObsActive);
        window.removeEventListener('obsSourceVisibleChanged', onObsVisible);
      }
    };
  }, []);

  if (desktop) return true;

  const hasObsHost =
    (typeof window !== 'undefined' && 'obsstudio' in window) ||
    obsState.active !== null ||
    obsState.visible !== null;

  if (hasObsHost) {
    const obsShown =
      obsState.active !== null || obsState.visible !== null
        ? Boolean(obsState.active) || Boolean(obsState.visible)
        : docVisible;
    const sceneTargeted =
      scenes === null ||
      scenes.active === sceneId ||
      scenes.preparing?.target === sceneId ||
      scenes.director?.next === sceneId ||
      scenes.director?.readyToTake === sceneId;
    return obsShown || sceneTargeted;
  }

  return docVisible;
}
