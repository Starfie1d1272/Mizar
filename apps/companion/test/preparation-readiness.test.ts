import { expect, it, vi } from 'vitest';
import type { ObsStatus } from '../src/obs/adapter.js';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { obsReadiness } from '../src/program-scenes/readiness.js';
import { obsSceneName } from '../src/obs/desired-state.js';

const rpc = vi.hoisted(() => ({ unavailable: false, failCheck: false }));
vi.mock('obs-websocket-js', () => ({
  OBSWebSocket: class {
    connect() {
      return rpc.unavailable ? Promise.reject(new Error('offline')) : Promise.resolve();
    }
    disconnect() {
      return Promise.resolve();
    }
    call(type: string) {
      if (type === 'GetSceneCollectionList') {
        if (rpc.failCheck) return Promise.reject(new Error('check failed'));
        return Promise.resolve({ sceneCollections: [] });
      }
      if (type === 'GetCurrentProgramScene')
        return Promise.resolve({ currentProgramSceneName: 'Mizar · 赛前等待' });
      if (type === 'GetVideoSettings')
        return Promise.resolve({
          baseWidth: 1920,
          baseHeight: 1080,
          outputWidth: 1920,
          outputHeight: 1080,
          fpsNumerator: 60,
          fpsDenominator: 1,
        });
      return Promise.resolve({ outputActive: false });
    }
  },
}));

const connected: ObsStatus = {
  connection: 'connected',
  currentScene: obsSceneName('waiting'),
  port: 4455,
  streaming: false,
  recording: false,
  passwordConfigured: false,
  video: null,
  findings: [],
};
it('requires connected OBS, aligned scene and no configuration findings', () => {
  expect(obsReadiness(connected, 'waiting').ready).toBe(true);
  expect(
    obsReadiness(
      { ...connected, findings: [{ code: 'browser_url', message: '浏览器源地址需要修复。' }] },
      'waiting',
    ),
  ).toMatchObject({ ready: false, reason: '浏览器源地址需要修复。' });
  expect(obsReadiness({ ...connected, currentScene: 'Unrelated' }, 'waiting')).toMatchObject({
    ready: false,
    reason: '当前场景与播出场景不一致',
  });
  expect(obsReadiness({ ...connected, currentScene: null }, 'waiting').ready).toBe(false);
  expect(obsReadiness({ ...connected, connection: 'password_required' }, 'waiting').reason).toBe(
    '需要密码',
  );
  expect(obsReadiness({ ...connected, connection: 'invalid_password' }, 'waiting').reason).toBe(
    '密码无效',
  );
  expect(obsReadiness(undefined, 'waiting').ready).toBe(false);
});
it('never treats an unchecked adapter as a verified OBS configuration', async () => {
  const adapter = new ObsAdapter(new ObsConfigStore('/unused/obs.json'), 'http://127.0.0.1:3000');
  rpc.unavailable = true;
  // Unavailable transport still exposes the initial check finding, not an empty success.
  const status = await adapter.status();
  expect(status.findings).toEqual([
    { code: 'configuration_unchecked', message: '请检查 OBS 场景配置。' },
  ]);
  rpc.unavailable = false;
});

it('checks actual OBS configuration during status reads and exposes RPC check failure separately from connection', async () => {
  const adapter = new ObsAdapter(new ObsConfigStore('/unused/obs.json'), 'http://127.0.0.1:3000');
  const status = await adapter.status();
  expect(status.connection).toBe('connected');
  expect(status.findings[0]?.code).toBe('collection_missing');
  expect(obsReadiness(status, 'waiting').ready).toBe(false);
  rpc.failCheck = true;
  try {
    const failed = await adapter.status();
    expect(failed.connection).toBe('connected');
    expect(failed.findings[0]?.code).toBe('configuration_check_failed');
    expect(obsReadiness(failed, 'waiting').ready).toBe(false);
  } finally {
    rpc.failCheck = false;
  }
});
