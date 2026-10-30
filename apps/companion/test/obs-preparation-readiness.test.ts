import { test } from 'node:test';
import assert from 'node:assert/strict';
import { obsReadiness } from '../src/program-scenes/readiness.js';
import { obsFindingReadiness } from '../src/obs/prepare-readiness.js';
import { ensureObsConfiguration, type ObsRpc } from '../src/obs/reconcile.js';
import { obsDesiredScenes } from '../src/obs/desired-state.js';
import type { ObsStatus } from '../src/obs/adapter.js';
import type { ObsAdapter } from '../src/obs/adapter.js';
import type { ObsConfigStore } from '../src/obs/config.js';
import Fastify from 'fastify';
import { registerObsRoutes } from '../src/obs/routes.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';

const activeScene = 'waiting';
const baseUrl = 'http://127.0.0.1:3000';

test('audio preferences remain visible without masking actual setup failures', () => {
  const findings = [
    { code: 'audio_muted:麦克风', message: '麦克风已静音' },
    { code: 'audio_tracks:音乐', message: '音乐未分配音轨' },
  ];
  const status: ObsStatus = {
    connection: 'connected',
    currentScene: obsDesiredScenes(baseUrl).find((s) => s.id === activeScene)!.sceneName,
    port: 4455,
    streaming: false,
    recording: false,
    passwordConfigured: false,
    video: null,
    findings,
  };
  const ready = obsReadiness(status, activeScene);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.warnings, findings);
  assert.deepEqual(ready.blockingFindings, []);
  const failed = obsReadiness(
    { ...status, findings: [...findings, { code: 'capture_drift', message: '画面未配置' }] },
    activeScene,
  );
  assert.equal(failed.ready, false);
  assert.equal(failed.reason, '画面未配置');
  assert.deepEqual(failed.warnings, findings);
  assert.equal(
    obsFindingReadiness([{ code: 'unknown_future', message: '未知状态' }]).blockingFindings.length,
    1,
  );
  assert.equal(obsReadiness({ ...status, connection: 'unavailable' }, activeScene).ready, false);
  assert.equal(obsReadiness({ ...status, currentScene: 'Personal' }, activeScene).ready, false);
});

test('OBS status and explicit ensure expose the same blocking and warning facts', async () => {
  const app = Fastify();
  const findings = [
    { code: 'audio_muted:麦克风', message: '麦克风已静音' },
    { code: 'source_missing', message: '缺少来源' },
  ];
  const status: ObsStatus = {
    connection: 'connected',
    currentScene: obsDesiredScenes(baseUrl).find((scene) => scene.id === activeScene)!.sceneName,
    port: 4455,
    streaming: false,
    recording: false,
    passwordConfigured: false,
    video: null,
    findings,
  };
  const adapter = {
    status: async () => status,
    ensure: async () => findings,
  } as unknown as ObsAdapter;
  registerObsRoutes(app, {
    adapter,
    configStore: {} as ObsConfigStore,
    originPolicy: createLocalWebOriginPolicy(),
    activeScene: () => activeScene,
    preparationValid: () => () => true,
  });
  try {
    const read = await app.inject({ method: 'GET', url: '/local/v1/obs' });
    const ensure = await app.inject({
      method: 'POST',
      url: '/operator/obs/ensure',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { expectedRevision: 'revision' },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(ensure.statusCode, 200);
    assert.equal(read.json().readiness.ready, false);
    assert.deepEqual(read.json().readiness.blockingFindings, ensure.json().blockingFindings);
    assert.deepEqual(read.json().readiness.warnings, ensure.json().warnings);
  } finally {
    await app.close();
  }
});

test('explicit ensure repairs legacy names even when no other finding requires repair', async () => {
  const desired = obsDesiredScenes(baseUrl);
  const inputs = [
    ...desired.map((scene) => ({ inputName: scene.browserInput, inputKind: 'browser_source' })),
    { inputName: '游戏画面', inputKind: 'game_capture' },
    { inputName: 'Mizar · Desktop Audio', inputKind: 'wasapi_output_capture' },
  ];
  let outputActive = false;
  const calls: string[] = [];
  const obs: ObsRpc = {
    call: async (type, data = {}) => {
      calls.push(type);
      const scene = desired.find((item) => item.sceneName === data.sceneName);
      if (type === 'GetSceneCollectionList')
        return { currentSceneCollectionName: 'Mizar', sceneCollections: ['Mizar'] };
      if (type === 'GetSceneTransitionList')
        return {
          transitions: [
            { transitionKind: 'fade_transition' },
            { transitionKind: 'cut_transition' },
          ],
        };
      if (type === 'GetVideoSettings')
        return {
          baseWidth: 1920,
          baseHeight: 1080,
          outputWidth: 1920,
          outputHeight: 1080,
          fpsNumerator: 60,
          fpsDenominator: 1,
        };
      if (type === 'GetSceneList')
        return { scenes: desired.map((item) => ({ sceneName: item.sceneName })) };
      if (type === 'GetInputList') return { inputs };
      if (type === 'GetInputPropertiesListPropertyItems') return { propertyItems: [] };
      if (type === 'GetInputSettings') {
        if (data.inputName === '游戏画面')
          return {
            inputSettings: {
              capture_mode: 'window',
              window: 'Counter-Strike 2:SDL_app:cs2.exe',
              priority: 2,
            },
          };
        const inputScene = desired.find((item) => item.browserInput === data.inputName)!;
        return { inputSettings: { url: inputScene.browserUrl, width: 1920, height: 1080 } };
      }
      if (type === 'GetSceneItemList')
        return {
          sceneItems: scene!.sources.map((name, index) => ({
            sourceName: name,
            sceneItemId: index + 1,
            sceneItemIndex: index,
            sceneItemEnabled: true,
          })),
        };
      if (type === 'GetSceneItemTransform') {
        const source = scene!.sources[Number(data.sceneItemId) - 1];
        return {
          sceneItemTransform:
            source === '游戏画面'
              ? {
                  positionX: 0,
                  positionY: 0,
                  rotation: 0,
                  boundsType: 'OBS_BOUNDS_STRETCH',
                  boundsWidth: 1920,
                  boundsHeight: 1080,
                  cropLeft: 0,
                  cropRight: 0,
                  cropTop: 0,
                  cropBottom: 0,
                }
              : {
                  positionX: 0,
                  positionY: 0,
                  rotation: 0,
                  scaleX: 1,
                  scaleY: 1,
                  boundsType: 'OBS_BOUNDS_NONE',
                  cropLeft: 0,
                  cropRight: 0,
                  cropTop: 0,
                  cropBottom: 0,
                },
        };
      }
      if (type === 'GetStreamStatus') return { outputActive };
      if (type === 'GetRecordStatus') return { outputActive: false };
      if (type === 'SetInputName') {
        inputs.find((item) => item.inputName === data.inputName)!.inputName = String(
          data.newInputName,
        );
        return {};
      }
      if (['SetInputSettings', 'SetSceneItemTransform', 'SetSceneItemIndex'].includes(type))
        return {};
      throw new Error(`Unexpected request ${type}`);
    },
  };
  outputActive = true;
  await assert.rejects(
    ensureObsConfiguration(obs, baseUrl, () => activeScene, true),
    /输出/,
  );
  assert.equal(calls.includes('SetInputName'), false);
  outputActive = false;
  const findings = await ensureObsConfiguration(obs, baseUrl, () => activeScene, true);
  assert.equal(
    findings.some((item) => item.code === 'legacy_names'),
    false,
  );
  assert.ok(inputs.some((input) => input.inputName === '桌面声音'));
  assert.ok(calls.includes('SetInputName'));
  assert.equal(
    calls.some((type) => type.startsWith('Stop')),
    false,
  );
});
