import type { ProgramProjection } from '@mizar/core/projection';
import { observerMapScope, type ObserverMapScope } from '../scope/identities.js';
import type { ObserverSettingsStore } from './observer-settings.js';

export function createObserverAssistScope(
  settings: ObserverSettingsStore,
  eligible: () => boolean,
) {
  let matchId: string | null | undefined;
  let confirmedMap: ObserverMapScope | undefined;
  let waitingMap: ObserverMapScope | undefined;

  return {
    get mapConfirmed() {
      return !waitingMap;
    },
    projectionSettings: () => ({
      ...settings.settings,
      enabled: settings.settings.enabled && eligible() && !waitingMap,
    }),
    canRecalibrate: (program: ProgramProjection) =>
      eligible() && program.status.telemetry === 'fresh' && Boolean(program.map.name),
    observe(program: ProgramProjection, resetAssist: () => void) {
      const map = observerMapScope(program);
      if (waitingMap && program.map.name && map !== waitingMap) {
        waitingMap = undefined;
        confirmedMap = map;
        settings.waitingForMap = false;
        resetAssist();
      }
      const nextMatch = program.match?.matchId ?? null;
      if (matchId !== undefined && matchId !== nextMatch) {
        settings.clearConnection();
        confirmedMap = waitingMap = undefined;
      }
      matchId = nextMatch;
      settings.observeScope(JSON.stringify([matchId, map]));
    },
    subscribe(input: {
      program(): ProgramProjection;
      refresh(): void;
      refreshAssist(): void;
      resetAssist(): void;
      mapConnectionChanged(): void;
    }) {
      return settings.subscribe((kind) => {
        if (kind === 'name') {
          input.refresh();
        } else if (kind === 'map') {
          const program = input.program();
          const map = program.map.name ? observerMapScope(program) : undefined;
          waitingMap =
            settings.mapConnection?.nextMap &&
            map &&
            (map === confirmedMap || program.map.phase === 'gameover')
              ? map
              : undefined;
          confirmedMap = map;
          settings.waitingForMap = Boolean(waitingMap);
          input.mapConnectionChanged();
          input.resetAssist();
        } else if (kind !== 'game') {
          if (kind === 'connection') confirmedMap = waitingMap = undefined;
          input.refreshAssist();
        }
      });
    },
  };
}
