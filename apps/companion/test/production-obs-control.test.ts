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
    controlValid: () => () => true,
  } as unknown as ProgramSceneController;
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let released = false;
  const production = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    beforeFinish: () => pending,
    release: () => {
      released = true;
      return Promise.reject(new Error('release failed'));
    },
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
  const shutdown = production.shutdown();
  await Promise.resolve();
  assert.equal(released, false);
  settle();
  const result = await shutdown;
  assert.equal(result.code, 409);
  assert.equal(production.get().mode, 'preparation');
  assert.equal(valid(), false);
  assert.ok(holds >= 1);
  await app.close();
});

test('external hold invalidates a manual take queued behind another operation', async () => {
  const { ProgramSceneController } = await import('../src/program-scenes/controller.js');
  const projections = {
    getBpAssessment: () => ({ readiness: 'not_ready' }),
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
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const writes: string[] = [];
  const scenes = new ProgramSceneController(
    projections as never,
    {} as never,
    async (id, options) => {
      started();
      await pending;
      if (options.valid?.()) writes.push(id);
    },
  );
  const revision = scenes.get().revision;
  const first = scenes.select('gameplay', revision);
  await entered;
  const queued = scenes.select('waiting', revision);
  scenes.holdAutomatic();
  resume();
  assert.equal((await first).ok, false);
  assert.equal((await queued).ok, false);
  assert.deepEqual(writes, []);
});

test('exit waiting for background work fails after external control changes', async () => {
  const app = Fastify();
  let generation = 0;
  let resume!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let writes = 0;
  const scenes = {
    get: () => ({ active: 'gameplay', revision: 'scene' }),
    holdAutomatic: () => {
      generation++;
    },
    controlValid: () => {
      const captured = generation;
      return () => captured === generation;
    },
    selectWaitingForExit: () => {
      writes++;
      return Promise.resolve({ ok: true });
    },
  } as unknown as ProgramSceneController;
  const production = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    beforeFinish: async () => {
      started();
      await pending;
    },
    release: () => {
      writes++;
      return Promise.resolve();
    },
  });
  const exit = production.shutdown();
  await entered;
  scenes.holdAutomatic();
  resume();
  assert.equal((await exit).code, 409);
  assert.equal(writes, 0);
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

test('video restoration runs after the safe scene and blocks release on failure', async () => {
  const app = Fastify();
  const calls: string[] = [];
  const scenes = {
    get: () => ({ active: 'waiting', revision: 'scene' }),
    holdAutomatic: () => undefined,
    controlValid: () => () => true,
    selectWaitingForExit: async () => {
      calls.push('waiting');
      return { ok: true };
    },
  } as unknown as ProgramSceneController;
  const production = registerProductionRoutes(app, {
    originPolicy: createLocalWebOriginPolicy(),
    hasContext: () => true,
    scenes,
    afterSafeScene: () => {
      calls.push('restore');
      throw new Error('restore failed');
    },
    release: async () => {
      calls.push('release');
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/operator/production',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { action: 'finish', expectedRevision: production.get().revision },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(calls, ['waiting', 'restore']);
  await app.close();
});
