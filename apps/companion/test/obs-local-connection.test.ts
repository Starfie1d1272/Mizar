import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLocalWebSocketSettings } from '../src/obs/local-connection.js';

test('reads only enabled OBS WebSocket settings and treats missing authentication data as unknown', () => {
  const settings = { server_enabled: true, server_port: 4466, auth_required: true };
  assert.deepEqual(parseLocalWebSocketSettings({ ...settings, server_password: 'sample' }), {
    port: 4466,
    password: 'sample',
  });
  assert.deepEqual(parseLocalWebSocketSettings({ ...settings, auth_required: false }), {
    port: 4466,
    password: '',
  });
  assert.throws(() => parseLocalWebSocketSettings(settings), /local_obs_settings_unavailable/);
  assert.throws(
    () => parseLocalWebSocketSettings({ ...settings, server_enabled: false }),
    /local_obs_websocket_disabled/,
  );
  assert.throws(
    () => parseLocalWebSocketSettings({ ...settings, server_port: 0 }),
    /local_obs_settings_unavailable/,
  );
});
