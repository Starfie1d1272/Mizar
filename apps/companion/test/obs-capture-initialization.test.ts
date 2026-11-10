import { expect, it } from 'vitest';
import Fastify from 'fastify';
import type { ObsCaptureDiagnostic } from '@mizar/protocol/obs';
import { readCaptureInitialization } from '../src/obs/capture-initialization.js';
import { projectObsCaptureDiagnostic } from '../src/obs/capture-diagnostic.js';
import { registerObsRoutes } from '../src/obs/routes.js';
import type { ObsAdapter } from '../src/obs/adapter.js';
import type { ObsConfigStore } from '../src/obs/config.js';
import type { ObsNativeEvidence } from '../src/obs/native-evidence.js';
import { OBS_COLLECTION } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const success: ObsCaptureDiagnostic = {
  state: 'reported_success',
  reason: null,
  code: null,
  lastFailure: null,
  owner: 'unknown',
};

function rpc(): ObsRpc {
  return {
    async call(type) {
      switch (type) {
        case 'GetSceneCollectionList':
          return { currentSceneCollectionName: OBS_COLLECTION };
        case 'GetInputList':
          return {
            inputs: [{ inputName: '游戏画面', inputKind: 'game_capture', inputUuid: 'one' }],
          };
        case 'GetInputSettings':
          return {
            inputSettings: { capture_mode: 'window', window: 'Counter-Strike 2:SDL_app:cs2.exe' },
          };
        case 'GetInputPropertiesListPropertyItems':
          return {
            propertyItems: ['Counter-Strike 2:SDL_app:cs2.exe'].map((itemValue) => ({ itemValue })),
          };
        case 'GetSceneItemList':
          return {
            sceneItems: [{ sourceName: '游戏画面', sceneItemEnabled: true, sceneItemId: 7 }],
          };
        case 'GetSourceActive':
          return { videoShowing: true };
        case 'GetSceneItemTransform':
          return { sceneItemTransform: { sourceWidth: 1920, sourceHeight: 1080 } };
        default:
          throw new Error(`unexpected OBS request ${type}`);
      }
    },
  };
}

it('rejects a capture that becomes zero-sized during the read', async () => {
  const original = rpc();
  let reads = 0;
  const changing: ObsRpc = {
    call(type, data) {
      if (type === 'GetSceneItemTransform' && ++reads === 2)
        return Promise.resolve({ sceneItemTransform: { sourceWidth: 0, sourceHeight: 0 } });
      return original.call(type, data);
    },
  };
  expect(await readCaptureInitialization(changing, success)).toMatchObject({
    state: 'unknown',
    reason: 'evidence_unknown',
  });
});

it('does not reuse a prior game capture success as evidence of this launch', () => {
  const now = Date.now();
  const evidence = {
    collectionStatus: 'available',
    processes: [{ role: 'obs', pid: 42 }],
    roots: [
      {
        logs: [
          {
            processAssociation: 'time_correlated',
            processPid: 42,
            timestampStatus: 'ordered',
            latestCaptureEvent: {
              occurredAt: new Date(now - 1000).toISOString(),
              outcome: 'success',
              source: 'mizar_capture',
            },
          },
        ],
      },
    ],
  } as unknown as ObsNativeEvidence;
  expect(projectObsCaptureDiagnostic(evidence, now, now - 2000).state).toBe('reported_success');
  expect(projectObsCaptureDiagnostic(evidence, now, now - 500).state).toBe('unknown');
  expect(projectObsCaptureDiagnostic(evidence, now + 31000, now - 2000).state).toBe('unknown');
});

it('checks origin, launch time and current production revision at the real route boundary', async () => {
  const app = Fastify();
  let valid = true;
  const eventAt = Date.now();
  const evidence = {
    collectionStatus: 'available',
    processes: [{ role: 'obs', pid: 42 }],
    roots: [
      {
        logs: [
          {
            processAssociation: 'time_correlated',
            processPid: 42,
            timestampStatus: 'ordered',
            latestCaptureEvent: {
              occurredAt: new Date(eventAt).toISOString(),
              outcome: 'success',
              source: 'mizar_capture',
            },
          },
        ],
      },
    ],
  } as unknown as ObsNativeEvidence;
  registerObsRoutes(app, {
    adapter: {
      captureWarmupMatches: async () => true,
      captureInitialization: (diagnostic: ObsCaptureDiagnostic) =>
        readCaptureInitialization(rpc(), diagnostic),
    } as unknown as ObsAdapter,
    configStore: {} as ObsConfigStore,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    activeScene: () => 'waiting',
    preparationValid: (revision) => () => valid && revision === 'revision',
    readCaptureEvidence: async () => evidence,
  });
  const request = (origin: string, since: number) =>
    app.inject({
      method: 'POST',
      url: '/operator/obs/capture-initialization',
      headers: { origin },
      payload: {
        expectedRevision: 'revision',
        since,
        transactionId: '00000000-0000-4000-8000-000000000001',
      },
    });
  try {
    expect((await request('https://outside.example', eventAt - 500)).statusCode).toBe(403);
    expect((await request('http://127.0.0.1:3000', eventAt - 700_000)).statusCode).toBe(400);
    expect((await request('http://127.0.0.1:3000', eventAt - 500)).json().state).toBe(
      'initialized',
    );
    const later = await request('http://127.0.0.1:3000', eventAt + 1);
    expect(later.json().captureDiagnostic.state).toBe('unknown');
    valid = false;
    expect((await request('http://127.0.0.1:3000', eventAt - 500)).statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
