import type { MigrationEvent, MigrationObserver } from './audio-migration.js';

/** Use with the same live, event-subscribed OBS connection as the transaction RPC. */
export interface MigrationEventSource {
  on(event: string, listener: (event: unknown) => void): void;
  off(event: string, listener: (event: unknown) => void): void;
}
export function observeAudioMigration(source: MigrationEventSource): MigrationObserver {
  return {
    subscribe(listener) {
      const handlers: [string, (payload: unknown) => void][] = [];
      const on = (event: string, handler: (payload: unknown) => void) => {
        handlers.push([event, handler]);
        source.on(event, handler);
      };
      const signal = (event: MigrationEvent) => () => listener(event);
      on('ConnectionClosed', signal({ type: 'disconnected' }));
      for (const name of [
        'CurrentSceneCollectionChanging',
        'CurrentSceneCollectionChanged',
        'InputCreated',
        'InputRemoved',
        'InputSettingsChanged',
        'InputMuteStateChanged',
        'InputVolumeChanged',
        'InputAudioTracksChanged',
        'InputAudioMonitorTypeChanged',
        'SceneCreated',
        'SceneItemCreated',
        'SceneItemRemoved',
        'SceneRemoved',
        'SourceFilterCreated',
        'SourceFilterRemoved',
        'SourceFilterEnableStateChanged',
        'SourceFilterSettingsChanged',
      ])
        on(name, signal({ type: 'identityChanged' }));
      for (const name of ['StreamStateChanged', 'RecordStateChanged'])
        on(name, (payload) => {
          if (
            typeof payload !== 'object' ||
            payload === null ||
            (payload as Record<string, unknown>).outputActive !== false ||
            (payload as Record<string, unknown>).outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING'
          )
            listener({ type: 'outputStarting' });
        });
      on('SceneItemEnableStateChanged', (payload) => {
        if (typeof payload !== 'object' || payload === null) {
          listener({ type: 'identityChanged' });
          return;
        }
        const item = payload as Record<string, unknown>;
        if (
          typeof item.sceneName !== 'string' ||
          typeof item.sceneItemId !== 'number' ||
          typeof item.sceneItemEnabled !== 'boolean'
        ) {
          listener({ type: 'identityChanged' });
          return;
        }
        listener({
          type: 'item',
          sceneName: item.sceneName,
          sceneItemId: item.sceneItemId,
          enabled: item.sceneItemEnabled,
        });
      });
      return () => {
        for (const [event, handler] of handlers) source.off(event, handler);
      };
    },
  };
}
