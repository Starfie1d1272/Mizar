import type { ProgramProjection } from '@mizar/core/projection';
import { observerMapScope, sameSourceSession } from '../scope/identities.js';
import type { ObserverSettingsStore } from './observer-settings.js';

export function createObserverAssistScope(
  settings: ObserverSettingsStore,
  eligible: () => boolean,
) {
  let matchId: string | null | undefined;
  let waitingMap: { cursor: ProgramProjection['cursor']; order: number | null } | undefined;

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
        sameSourceSession(program.cursor, waitingMap.cursor) &&
        program.cursor.mapEpoch > waitingMap.cursor.mapEpoch &&
        waitingMap.order !== null &&
        order === waitingMap.order + 1
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
                  cursor: program.cursor,
                  order: program.series?.currentMapOrder ?? null,
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
