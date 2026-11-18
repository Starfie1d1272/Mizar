import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { registerManagedSourceRoutes } from '../src/match-context/managed-source.js';

const TOKEN = 'a'.repeat(64);

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const app = Fastify();
  let productionSession = 'session-1';
  const runtime = {
    getCurrentState: () => ({
      programSource: { generation: 0, lastAccepted: null },
    }),
    retireManagedSource: () => ({}),
  };
  const managed = registerManagedSourceRoutes(app, {
    controlToken: TOKEN,
    loopback: true,
    controller: null,
    runtime: runtime as never,
    productionSession: () => productionSession,
    onRuntimeCommit: () => {},
  });
  t.after(() => app.close());
  return {
    app,
    managed,
    setSession: (value: string) => {
      productionSession = value;
    },
  };
}

async function post(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/operator/runtime/managed-source',
    headers: { 'x-runtime-token': TOKEN },
    payload: payload as NonNullable<InjectOptions['payload']>,
  }) as unknown as Promise<LightMyRequestResponse>;
}

test('ending production before a source commits cannot strand the retirement', async (t) => {
  const { app, setSession, managed } = await setup(t);
  const prepared = await post(app, { action: 'prepare', requestId: 'request-1' });
  assert.equal(prepared.statusCode, 200);
  const source = prepared.json() as { ticket: string; sourceId: string };

  const retirement = await post(app, { action: 'retire', phase: 'prepare' });
  assert.equal(retirement.statusCode, 200);
  const ticket = retirement.json().ticket as string;

  const commit = {
    action: 'commit',
    ticket: source.ticket,
    managedSessionIdentity: { pid: 42, created: '1', executable: 'cs2.exe' },
  };
  assert.equal((await post(app, commit)).statusCode, 409);
  assert.equal((await post(app, { action: 'retire', phase: 'abort', ticket })).statusCode, 200);
  assert.equal((await post(app, commit)).statusCode, 200);
  assert.equal(managed.classify(source.sourceId), 'managed');

  const stale = await post(app, { action: 'retire', phase: 'prepare' });
  assert.equal(stale.statusCode, 200);
  setSession('session-2');
  const retried = await post(app, {
    action: 'retire',
    phase: 'prepare',
    expectedSourceId: source.sourceId,
  });
  assert.equal(retried.statusCode, 200);
  assert.notEqual(retried.json().ticket, stale.json().ticket);
  assert.equal(
    (
      await post(app, {
        action: 'retire',
        phase: 'prepare',
        expectedSourceId: randomUUID(),
      })
    ).statusCode,
    409,
  );

  assert.equal(
    (await post(app, { action: 'retire', phase: 'settle', ticket: retried.json().ticket }))
      .statusCode,
    200,
  );
  assert.equal(
    (await post(app, { action: 'retire', phase: 'confirm', ticket: retried.json().ticket }))
      .statusCode,
    200,
  );
  assert.equal(managed.classify(source.sourceId), 'drop');
});
