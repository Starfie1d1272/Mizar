import { expect, it } from 'vitest';
import { GameAudioPolicy, type AudioLease } from '../src/obs/audio-policy.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const binding = {
  inputUuid: 'game',
  inputKind: 'wasapi_process_output_capture',
  collection: 'A',
  endpoint: 'ws://127.0.0.1:4455',
};
function fixture() {
  let saved: AudioLease | null = null;
  let volume = 0.5;
  let muted = false;
  const writes: string[] = [];
  const store = {
    read: () => Promise.resolve(saved),
    write: (value: AudioLease | null) => {
      saved = value;
      return Promise.resolve();
    },
  };
  const policy = new GameAudioPolicy(store);
  const obs: ObsRpc = {
    call: async (type, data) => {
      await Promise.resolve();
      if (type === 'GetInputVolume') return { inputVolumeMul: volume };
      if (type === 'GetInputMute') return { inputMuted: muted };
      if (type === 'SetInputVolume') {
        writes.push(String(data?.inputUuid));
        volume = Number(data?.inputVolumeMul);
        policy.observe('game', 'volume', volume);
        return {};
      }
      if (type === 'SetInputMute') {
        writes.push(String(data?.inputUuid));
        muted = Boolean(data?.inputMuted);
        policy.observe('game', 'mute', muted);
        return {};
      }
      throw new Error(type);
    },
  };
  return {
    policy,
    obs,
    writes,
    store,
    volume: () => volume,
    setVolume: (v: number) => {
      volume = v;
      policy.observe('game', 'volume', v);
    },
  };
}
it('attenuates and restores only the selected game field', async () => {
  const f = fixture();
  await f.policy.apply(f.obs, 1, binding, 'r', { mode: 'attenuate', db: 6 }, () => true);
  expect(f.volume()).toBeCloseTo(0.5 * 10 ** (-6 / 20));
  await f.policy.restore(f.obs, 1, binding, 'r', () => true);
  expect(f.volume()).toBe(0.5);
  expect(f.writes).toEqual(['game', 'game']);
});
it('does not restore over an operator adjustment after relinquishing a lease', async () => {
  const f = fixture();
  await f.policy.apply(f.obs, 1, binding, 'r', { mode: 'attenuate', db: 6 }, () => true);
  await f.policy.relinquish();
  f.setVolume(0.8);
  await f.policy.restore(f.obs, 1, binding, 'r', () => true);
  expect(f.volume()).toBe(0.8);
  expect(f.policy.status).toBe('held');
  expect(f.writes).toHaveLength(1);
});
it('gives way when volume changes away and back, or connection changes', async () => {
  const f = fixture();
  await f.policy.apply(f.obs, 1, binding, 'r', { mode: 'attenuate', db: 6 }, () => true);
  const applied = f.volume();
  f.setVolume(0.8);
  f.setVolume(applied);
  await f.policy.restore(f.obs, 1, binding, 'r', () => true);
  expect(f.policy.status).toBe('held');
  expect(f.writes).toHaveLength(1);
  const g = fixture();
  await g.policy.apply(g.obs, 1, binding, 'r', { mode: 'mute' }, () => true);
  g.policy.disconnect();
  await g.policy.restore(g.obs, 2, binding, 'r', () => true);
  expect(g.writes).toHaveLength(1);
});
it('does not claim a lease left by a prior process', async () => {
  const f = fixture();
  await f.policy.apply(f.obs, 1, binding, 'r', { mode: 'mute' }, () => true);
  const restarted = new GameAudioPolicy(f.store);
  await restarted.restore(f.obs, 1, binding, 'r', () => true);
  expect(restarted.status).toBe('held');
  expect(f.writes).toHaveLength(1);
});

it('does not restore after the binding revision or scene collection changes', async () => {
  const f = fixture();
  await f.policy.apply(f.obs, 1, binding, 'r', { mode: 'attenuate', db: 6 }, () => true);
  await f.policy.restore(f.obs, 1, { ...binding, collection: 'B' }, 'r', () => true);
  expect(f.policy.status).toBe('held');
  expect(f.writes).toEqual(['game']);
});
it('does not replay an unacknowledged write', async () => {
  const f = fixture();
  const obs: ObsRpc = {
    call: async (type, data) => {
      if (type === 'SetInputVolume') {
        await f.obs.call(type, data);
        throw new Error('lost acknowledgement');
      }
      return f.obs.call(type, data);
    },
  };
  await expect(
    f.policy.apply(obs, 1, binding, 'r', { mode: 'attenuate', db: 6 }, () => true),
  ).rejects.toThrow('lost acknowledgement');
  await f.policy.restore(f.obs, 2, binding, 'r', () => true);
  expect(f.policy.status).toBe('held');
  expect(f.writes).toEqual(['game']);
});
