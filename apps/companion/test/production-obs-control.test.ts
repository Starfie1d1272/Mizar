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
      if (type === 'GetStreamStatus') return Promise.resolve({ outputActive: true });
      if (type === 'GetRecordStatus') return Promise.resolve({ outputActive: false });
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

test('begin exit revokes old preparation and holds the director even when cleanup fails', async () => {
  const app = Fastify();
  let holds = 0;
  const scenes = {
    get: () => ({ active: 'waiting', revision: 'scene' }),
    holdAutomatic: () => {
      holds++;
    },
  } as unknown as ProgramSceneController;
  const production = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    release: () => Promise.reject(new Error('release failed')),
  });
  const revision = production.get().revision;
  const valid = production.preparationValid(revision);
  assert.equal(valid(), true);
  const begin = await app.inject({
    method: 'POST',
    url: '/operator/production',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { action: 'begin-exit', expectedRevision: revision },
  });
  assert.equal(begin.statusCode, 200);
  assert.equal(valid(), false);
  assert.equal(production.preparationValid(revision)(), false);
  const result = await production.shutdown();
  assert.equal(result.code, 409);
  assert.equal(production.get().mode, 'preparation');
  assert.equal(valid(), false);
  assert.ok(holds >= 1);
  await app.close();
});

test('external hold cancels an in-flight automatic take without restoring the old scene', async () => {
  const { ProgramSceneController } = await import('../src/program-scenes/controller.js');
  const projections = {
    getCurrent: () => ({
      operator: {
        runtime: { telemetryFreshness: 'fresh' },
        matchContext: { freshness: 'fresh', origin: 'local' },
        identity: { state: 'ok' },
      },
      program: { series: null, round: null, clock: null },
    }),
  };
  let started!: () => void;
  let resume!: () => void;
  const startedTake = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pendingTake = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const targets: string[] = [];
  const scenes = new ProgramSceneController(
    projections as never,
    {} as never,
    async (id, options) => {
      targets.push(id);
      started();
      await pendingTake;
      options.signal?.throwIfAborted();
    },
  );
  scenes.attachDirector({ hold: () => undefined } as never);
  const revision = (scenes as unknown as { revision: string }).revision;
  const take = scenes.selectAutomatic('gameplay', revision, () => true);
  await startedTake;
  scenes.holdAutomatic();
  resume();
  const result = await take;
  assert.equal(result.ok, false);
  assert.deepEqual(targets, ['gameplay']);
});
