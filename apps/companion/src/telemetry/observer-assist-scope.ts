import type { ProgramProjection } from '@mizar/core/projection';
import { observerMapScope } from '../scope/identities.js';
import type { ObserverSettingsStore } from './observer-settings.js';

export function createObserverAssistScope(
  settings: ObserverSettingsStore,
  eligible: () => boolean,
) {
  let matchId: string | null | undefined;

  return {
    projectionSettings: () => ({
      ...settings.settings,
      enabled: settings.settings.enabled && !settings.receiverPaused && eligible(),
    }),
    observe(program: ProgramProjection) {
      const map = observerMapScope(program);
      const nextMatch = program.match?.matchId ?? null;
      if (matchId !== undefined && matchId !== nextMatch) {
        settings.clearConnection();
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
          input.mapConnectionChanged();
          input.resetAssist();
        } else if (kind !== 'game') {
          input.refreshAssist();
        }
      });
    },
  };
}
