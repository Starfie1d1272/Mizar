import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import {
  DefaultRenderDevice,
  desktopMonitorRelationship,
} from '../src/obs/audio-monitor-device.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

test('default render identity expires and resolves OBS selectors', async () => {
  let now = 0;
  const device = new DefaultRenderDevice(() => now);
  const obs: ObsRpc = {
    async call(type) {
      if (type === 'GetInputSettings') return { inputSettings: { device_id: 'default' } };
      if (type === 'GetInputDefaultSettings')
        return { defaultInputSettings: { device_id: 'default' } };
      if (type === 'GetProfileParameter') return { parameterValue: 'ENDPOINT-A' };
      throw new Error(`Unexpected request ${type}`);
    },
  };
  assert.equal(await desktopMonitorRelationship(obs, 'desktop', device.current()), 'unknown');
  device.update('endpoint-a');
  assert.equal(await desktopMonitorRelationship(obs, 'desktop', device.current()), 'same');
  device.update('endpoint-b');
  assert.equal(await desktopMonitorRelationship(obs, 'desktop', device.current()), 'different');
  now = 6000;
  assert.equal(await desktopMonitorRelationship(obs, 'desktop', device.current()), 'unknown');
});

test('only the native runtime capability can report the default endpoint', async () => {
  const token = 'a'.repeat(64);
  const app = buildApp({
    productRuntime: {
      artifactSha256: 'b'.repeat(64),
      gitSha: 'c'.repeat(40),
      instanceId: 'test',
      controlToken: token,
      stop: () => {},
    },
    logger: false,
  });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const post = (headers: Record<string, string>, body = { endpoint: 'endpoint-a' }) =>
      fetch(`${address}/operator/runtime/audio-default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ 'x-runtime-token': token, origin: address })).status, 403);
    assert.equal((await post({ 'x-runtime-token': token }, { endpoint: '' })).status, 400);
    assert.equal((await post({ 'x-runtime-token': token })).status, 200);
    assert.equal(
      (await post({ 'x-runtime-token': token }, { endpoint: null as unknown as string })).status,
      200,
    );
  } finally {
    await app.close();
  }
});
