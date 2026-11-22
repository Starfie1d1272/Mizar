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
  let binding: {
    context: {
      matchId: string;
      format: 'bo3';
      maps: never[];
      competition: { competitionId: string };
      entrants: { a: { entryId: string }; b: { entryId: string } };
    };
  } | null = null;
  const resumed: { sourceId: string; matchId: string | null }[] = [];
  let commits = 0;
  const runtime = {
    getCurrentState: () => ({
      programSource: { generation: 0, lastAccepted: null },
    }),
    retireManagedSource: () => ({}),
    resumeManagedSource: (sourceId: string, matchId: string | null) => {
      resumed.push({ sourceId, matchId });
      return { restored: false, snapshot: { resumed: { sourceId, matchId } } };
    },
  };
  const managed = registerManagedSourceRoutes(app, {
    controlToken: TOKEN,
    loopback: true,
    controller: { getActiveBinding: () => binding } as never,
    runtime: runtime as never,
    productionSession: () => productionSession,
    onRuntimeCommit: () => {
      commits++;
    },
  });
  t.after(() => app.close());
  return {
    app,
    managed,
    resumed,
    commits: () => commits,
    setSession: (value: string) => {
      productionSession = value;
    },
    setMatch: (matchId: string | null) => {
      binding = matchId
        ? {
            context: {
              matchId,
              format: 'bo3',
              maps: [],
              competition: { competitionId: 'comp-1' },
              entrants: { a: { entryId: 'team-a' }, b: { entryId: 'team-b' } },
            },
          }
        : null;
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

test('rebind covers pending, unactivated active, and GSI-activated active match transitions cleanly', async (t) => {
  const { app, setSession, setMatch, resumed, commits, managed } = await setup(t);
  setMatch('match-1');
  const p1 = (await post(app, { action: 'prepare', requestId: 'req-a' })).json() as {
    ticket: string;
    sourceId: string;
  };
  const identity = { pid: 100, created: '10', executable: 'cs2.exe' };

  // 1. pending -> rebind: session switches before commit; first GSI establishes runtime ownership.
  setSession('session-2');
  const staleCommit = await post(app, {
    action: 'commit',
    ticket: p1.ticket,
    managedSessionIdentity: identity,
  });
  assert.equal(staleCommit.statusCode, 409);
  assert.equal(staleCommit.json().error, 'managed_source_selection_changed');

  const reboundPending = await post(app, {
    action: 'rebind',
    ticket: p1.ticket,
    sourceId: p1.sourceId,
    managedSessionIdentity: identity,
  });
  assert.equal(reboundPending.statusCode, 200);
  assert.equal(managed.classify(p1.sourceId), 'managed');
  assert.equal(resumed.length, 0);

  // 2. active (unactivated) -> rebind: match changes before GSI arrives, no premature runtime reset.
  setMatch('match-2');
  assert.equal(managed.sourceMatchesSelection(p1.sourceId), false);
  const reboundUnactivated = await post(app, {
    action: 'rebind',
    ticket: p1.ticket,
    sourceId: p1.sourceId,
    managedSessionIdentity: identity,
  });
  assert.equal(reboundUnactivated.statusCode, 200);
  assert.equal(managed.sourceMatchesSelection(p1.sourceId), true);
  assert.equal(resumed.length, 0);

  // 3. active (GSI already received) -> rebind to match-3 reconciles runtime execution ownership.
  managed.confirmFirstObservation(p1.sourceId);
  setMatch('match-3');
  const reboundActivated = await post(app, {
    action: 'rebind',
    ticket: p1.ticket,
    sourceId: p1.sourceId,
    managedSessionIdentity: identity,
  });
  assert.equal(reboundActivated.statusCode, 200);
  assert.equal(managed.sourceMatchesSelection(p1.sourceId), true);
  assert.deepEqual(resumed, [{ sourceId: p1.sourceId, matchId: 'match-3' }]);
  assert.equal(commits(), 1);

  // prepare reports activeSourceId on 409 so Host can retire a dead old source cleanly.
  const blocked = await post(app, { action: 'prepare', requestId: 'req-b' });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().activeSourceId, p1.sourceId);

  const ret = (
    await post(app, { action: 'retire', phase: 'prepare', expectedSourceId: p1.sourceId })
  ).json() as { ticket: string };
  await post(app, { action: 'retire', phase: 'settle', ticket: ret.ticket });
  await post(app, { action: 'retire', phase: 'confirm', ticket: ret.ticket });

  // Already-retired sourceId cannot be resumed or rebound; a new sourceId prepares cleanly.
  const resumeRetired = await post(app, {
    action: 'resume',
    ticket: p1.ticket,
    sourceId: p1.sourceId,
    managedSessionIdentity: identity,
  });
  assert.equal(resumeRetired.statusCode, 409);
  assert.equal((await post(app, { action: 'prepare', requestId: 'req-b' })).statusCode, 200);
});
