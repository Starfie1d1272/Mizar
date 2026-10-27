import { expect, it } from 'vitest';
import { ObsConfigStore } from '../src/obs/config.js';
import { AudioConfigurationConnection } from '../src/obs/audio-configuration-connection.js';

for (const method of ['SetSceneItemEnabled', 'SetInputSettings'])
  it(`keeps observing ${method} until a timed-out write settles`, async () => {
    let release: (value: Record<string, unknown>) => void = () => undefined;
    let disconnected = false;
    let observed = false;
    const listeners = new Map<string, (event: unknown) => void>();
    const client = {
      connect: async () => {
        await Promise.resolve();
      },
      disconnect: async () => {
        await Promise.resolve();
        disconnected = true;
      },
      call: async () =>
        new Promise<Record<string, unknown>>((resolve) => {
          release = resolve;
        }),
      on: (event: string, fn: (event: unknown) => void) => {
        listeners.set(event, fn);
      },
      off: (event: string) => {
        listeners.delete(event);
      },
    };
    const connection = new AudioConfigurationConnection(
      new ObsConfigStore('/tmp/no-mizar-config.json'),
      () => client,
      10,
      1000,
    );
    const operation = connection.run(async (obs, _endpoint, observer) => {
      const unsubscribe = observer.subscribe(() => {
        observed = true;
      });
      try {
        return await obs.call(method);
      } finally {
        unsubscribe();
      }
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(disconnected).toBe(false);
    listeners.get(
      method === 'SetInputSettings' ? 'InputSettingsChanged' : 'SceneItemEnableStateChanged',
    )?.(
      method === 'SetInputSettings'
        ? { inputUuid: 'source', inputSettings: { window: 'target' } }
        : {
            sceneName: 'scene',
            sceneItemId: 1,
            sceneItemEnabled: true,
          },
    );
    expect(observed).toBe(true);
    release({});
    await expect(operation).resolves.toEqual({});
    expect(disconnected).toBe(true);
  });
