import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import type { OBSWebSocket } from 'obs-websocket-js';
import { GameAudioConnection } from '../src/obs/audio-policy-connection.js';
import { GameAudioPolicy, type AudioLease } from '../src/obs/audio-policy.js';
import type { ObsConfigStore } from '../src/obs/config.js';

const binding = {
  inputUuid: 'game',
  inputKind: 'wasapi_process_output_capture',
  collection: 'A',
  endpoint: 'ws://127.0.0.1:4455',
};
class Fake extends EventEmitter {
  volume = 0.5;
  muted = false;
  collection = 'A';
  writes = 0;
  connect() {
    return Promise.resolve({});
  }
  disconnect() {
    return Promise.resolve();
  }
  async call(name: string, data?: Record<string, unknown>) {
    await Promise.resolve();
    if (name === 'GetVersion')
      return {
        availableRequests: [
          'GetInputList',
          'GetSceneCollectionList',
          'GetInputVolume',
          'SetInputVolume',
          'GetInputMute',
          'SetInputMute',
        ],
      };
    if (name === 'GetSceneCollectionList') return { currentSceneCollectionName: this.collection };
    if (name === 'GetInputList')
      return { inputs: [{ inputUuid: 'game', inputKind: binding.inputKind }] };
    if (name === 'GetInputVolume') return { inputVolumeMul: this.volume };
    if (name === 'GetInputMute') return { inputMuted: this.muted };
    if (name === 'SetInputMute') {
      this.writes++;
      this.muted = Boolean(data?.inputMuted);
      this.emit('InputMuteStateChanged', { inputUuid: 'game', inputMuted: this.muted });
      return {};
    }
    if (name === 'SetInputVolume') {
      this.writes++;
      this.volume = Math.fround(Number(data?.inputVolumeMul));
      this.emit('InputVolumeChanged', { inputUuid: 'game', inputVolumeMul: this.volume });
      return {};
    }
    throw new Error(name);
  }
}
function setup() {
  let lease: AudioLease | null = null;
  const owner = new GameAudioPolicy({
    read: () => Promise.resolve(lease),
    write: (next) => {
      lease = next;
      return Promise.resolve();
    },
  });
  const obs = new Fake();
  const config = {
    read: () =>
      Promise.resolve({ host: '127.0.0.1', port: 4455, password: '', executablePath: null }),
  } as ObsConfigStore;
  return {
    owner,
    obs,
    connection: new GameAudioConnection(config, owner, () => obs as unknown as OBSWebSocket),
  };
}
it('round-trips a 6 dB attenuation through float32 and restores the original', async () => {
  const { connection, owner, obs } = setup();
  await connection.run(binding, 'r', 'halftime', { mode: 'attenuate', db: 6 }, () => true);
  expect(owner.status).toBe('owned');
  expect(obs.volume).toBe(Math.fround(0.5 * 10 ** (-6 / 20)));
  await connection.run(binding, 'r', 'gameplay', { mode: 'attenuate', db: 6 }, () => true);
  expect(owner.status).toBe('idle');
  expect(obs.volume).toBe(0.5);
  expect(obs.writes).toBe(2);
  connection.close();
});

it('gives way to a one-float32-step manual volume change', async () => {
  const { connection, owner, obs } = setup();
  await connection.run(binding, 'r', 'halftime', { mode: 'attenuate', db: 6 }, () => true);
  obs.volume = Math.fround(obs.volume + 2 ** -25);
  obs.emit('InputVolumeChanged', { inputUuid: 'game', inputVolumeMul: obs.volume });
  await connection.run(binding, 'r', 'gameplay', { mode: 'attenuate', db: 6 }, () => true);
  expect(owner.status).toBe('held');
  expect(obs.writes).toBe(1);
  connection.close();
});
it('retires the lease on disconnect or collection change', async () => {
  for (const event of ['ConnectionClosed', 'CurrentSceneCollectionChanging']) {
    const { connection, owner, obs } = setup();
    await connection.run(binding, 'r', 'halftime', { mode: 'attenuate', db: 6 }, () => true);
    obs.emit(event);
    await connection.run(binding, 'r', 'gameplay', { mode: 'attenuate', db: 6 }, () => true);
    expect(owner.status).toBe('held');
    expect(obs.writes).toBe(1);
    connection.close();
  }
});

it('does not write a missing or wrong-collection game source', async () => {
  const { connection, obs } = setup();
  obs.collection = 'other';
  await expect(
    connection.run(binding, 'r', 'halftime', { mode: 'attenuate', db: 6 }, () => true),
  ).rejects.toThrow('audio_binding_changed');
  expect(obs.writes).toBe(0);
  connection.close();
});

it('honors manual mute changes away and back', async () => {
  const { connection, owner, obs } = setup();
  await connection.run(binding, 'r', 'halftime', { mode: 'mute' }, () => true);
  obs.muted = false;
  obs.emit('InputMuteStateChanged', { inputUuid: 'game', inputMuted: false });
  obs.muted = true;
  obs.emit('InputMuteStateChanged', { inputUuid: 'game', inputMuted: true });
  await connection.run(binding, 'r', 'gameplay', { mode: 'mute' }, () => true);
  expect(owner.status).toBe('held');
  expect(obs.writes).toBe(1);
  connection.close();
});
