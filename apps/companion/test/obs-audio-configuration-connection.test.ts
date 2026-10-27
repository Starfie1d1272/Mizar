import { expect, it } from 'vitest';
import { ObsConfigStore } from '../src/obs/config.js';
import { AudioConfigurationConnection } from '../src/obs/audio-configuration-connection.js';

it('keeps the configuration connection until a timed-out write settles', async () => {
  let release: (value: Record<string, unknown>) => void = () => undefined;
  let disconnected = false;
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
  const operation = connection.run(async (obs) => obs.call('SetSceneItemEnabled'));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(disconnected).toBe(false);
  release({});
  await expect(operation).rejects.toThrow('timeout');
  expect(disconnected).toBe(true);
});
