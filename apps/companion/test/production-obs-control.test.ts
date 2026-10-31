import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import { ensureObsConfiguration, type ObsRpc } from '../src/obs/reconcile.js';
import { registerProductionRoutes } from '../src/program-scenes/production.js';
import type { ProgramSceneController } from '../src/program-scenes/controller.js';

test('passive OBS preparation never takes another collection, including while output is active', async () => {
  const calls: string[] = [];
  const obs: ObsRpc = {
    call: (type) => {
      calls.push(type);
      if (type === 'GetSceneCollectionList')
        return Promise.resolve({
          currentSceneCollectionName: 'Personal',
          sceneCollections: ['Personal', 'Mizar'],
        });
      if (type === 'GetOutputList')
        return Promise.resolve({
          outputs: [
            {
              outputName: 'Virtual camera',
              outputActive: true,
              outputFlags: { OBS_OUTPUT_VIDEO: true },
            },
          ],
        });
      throw new Error(`Unexpected OBS request: ${type}`);
    },
  };
  assert.equal(
    (await ensureObsConfiguration(obs, 'http://127.0.0.1:3000'))[0]?.code,
    'collection_inactive',
  );
  await assert.rejects(ensureObsConfiguration(obs, 'http://127.0.0.1:3000', () => 'waiting', true));
  assert.ok(calls.every((type) => type.startsWith('Get')));
});

test('browser recovery is granted after entering and revoked on exit intent', async () => {
  const app = Fastify();
  let valid: (() => boolean) | undefined;
  let seenMode = '';
  let seenRevision = '';
  const scenes = {
    get: () => ({ active: 'waiting', revision: 'scene' }),
    holdAutomatic: () => undefined,
    controlValid: () => () => true,
  } as unknown as ProgramSceneController;
  const production = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    release: async () => undefined,
    onEntered: () => {
      seenMode = production.get().mode;
      seenRevision = production.get().revision;
      valid = production.sessionValid();
    },
  });
  const initialRevision = production.get().revision;
  const request = (action: string, expectedRevision: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action, expectedRevision },
    });
  const enter = await request('enter', initialRevision);
  assert.equal(enter.statusCode, 200);
  assert.equal(seenMode, 'live');
  assert.notEqual(seenRevision, initialRevision);
  assert.equal(valid?.(), true);
  const hide = await request('hide', seenRevision);
  assert.equal(hide.statusCode, 200);
  assert.equal(valid?.(), true);
  await request('begin-exit', production.get().revision);
  assert.equal(valid?.(), false);
  await app.close();
});
