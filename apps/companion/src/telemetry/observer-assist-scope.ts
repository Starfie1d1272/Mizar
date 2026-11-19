import type { ProgramProjection } from '@mizar/core/projection';
import { observerMapScope } from '../scope/identities.js';
import type { ObserverSettingsStore } from './observer-settings.js';

export function createObserverAssistScope(
  settings: ObserverSettingsStore,
  eligible: () => boolean,
) {
  let matchId: string | null | undefined;
  let waitingMap: { name: string; epoch: number; order: number | null | undefined } | undefined;

  return {
    get mapConfirmed() {
      return !waitingMap;
    },
    projectionSettings: () => ({
      ...settings.settings,
      enabled: settings.settings.enabled && !settings.receiverPaused && eligible(),
      waitingForNextMap: Boolean(waitingMap),
    }),
    observe(program: ProgramProjection, resetAssist: () => void) {
      const map = observerMapScope(program);
      const nextMatch = program.match?.matchId ?? null;
      if (matchId !== undefined && matchId !== nextMatch) {
        settings.clearConnection();
        waitingMap = undefined;
      }
      const order = program.series?.currentMapOrder;
      if (
        waitingMap &&
        program.map.name &&
        program.status.telemetry === 'fresh' &&
        program.cursor.mapEpoch !== waitingMap.epoch &&
        (typeof waitingMap.order === 'number'
          ? order === waitingMap.order + 1
          : program.map.name !== waitingMap.name)
      ) {
        waitingMap = undefined;
        settings.waitingForMap = false;
        resetAssist();
      }
      matchId = nextMatch;
      settings.observeScope(JSON.stringify([matchId, map]), Boolean(waitingMap));
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
          waitingMap =
            settings.mapConnection?.nextMap && program.map.name
              ? {
                  name: program.map.name,
                  epoch: program.cursor.mapEpoch,
                  order: program.series?.currentMapOrder,
                }
              : undefined;
          settings.waitingForMap = Boolean(waitingMap);
          input.mapConnectionChanged();
          if (waitingMap) input.refreshAssist();
          else input.resetAssist();
        } else if (kind !== 'game') {
          if (kind === 'connection') waitingMap = undefined;
          input.refreshAssist();
        }
      });
    },
  };
}
