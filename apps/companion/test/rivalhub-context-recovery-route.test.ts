import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';

test('automatic and operator refresh coalesce through the controller and retain source fences', async (t) => {
  const snapshot = parseLiveSnapshotV1(
    JSON.parse(
      await readFile(
        new URL('../../../packages/protocol/test/fixtures/live-snapshot-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  snapshot.cursor.liveSessionId = 'session-1';
  snapshot.players = Array.from({ length: 10 }, (_, i) => ({
    lineupEvidence: 'current',
    sourcePlayerId: String(76561198000000000n + BigInt(i)),
  })) as never;
  const event = parseReliableEventV1({
    ...JSON.parse(
      await readFile(
        new URL('../../../packages/protocol/test/fixtures/reliable-event-v1.json', import.meta.url),
        'utf8',
      ),
    ),
    kind: 'map_started',
    payload: {},
    cursor: snapshot.cursor,
  });
  const binding = {
    origin: 'online',
    freshness: 'fresh',
    context: { matchId: snapshot.matchId, competition: { competitionId: snapshot.competitionId } },
    manifest: { match: { competition: { competitionId: snapshot.competitionId } } },
  };
  let authority = 'claim-1';
  let pending = false;
  let count = 0;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const controller = {
    getActiveBinding: () => binding,
    getPendingOnlineCandidate: () => (pending ? { binding } : null),
    isOnlineCandidateLoading: () => true,
    refreshOnlineMatch: async () => {
      count++;
      await waiting;
      return { ok: true };
    },
  };
  const progress: string[] = [];
  const connection = {
    setDiagnosticHandler: () => undefined,
    view: () => ({
      paired: true,
      competitionId: snapshot.competitionId,
      activeSourceMatchId: snapshot.matchId,
      stoppedMatchId: null,
      activeDeviceName: null,
    }),
    reliableAuthorityScope: () => authority,
    setContextRecoveryProgress: (_event: unknown, _scope: unknown, state: string) =>
      progress.push(state),
    matchSource: () => ({ kind: 'online', load: async () => ({}) }),
    clearStats: () => undefined,
  };
  let recover!: (item: typeof event, authority: string) => Promise<boolean>;
  const app = Fastify();
  t.after(() => app.close());
  registerRivalHubConnectionRoutes(app, {
    connection,
    controller,
    canClaim: () => true,
    currentSnapshot: () => snapshot,
    setContextRecoveryHandler: (handler: typeof recover) => {
      recover = handler;
    },
    originPolicy: { mode: 'loopback' },
  } as never);
  await app.ready();
  const automatic = recover(event, authority);
  const manual = app.inject({
    method: 'POST',
    url: '/operator/rivalhub/refresh',
    headers: { origin: 'http://127.0.0.1:4173' },
    payload: {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
  finish();
  assert.equal(await automatic, true);
  assert.equal((await manual).statusCode, 200);
  assert.deepEqual(progress, ['context_refreshing', 'context_reconfirming']);
  pending = true;
  assert.equal(await recover(event, authority), false);
  pending = false;
  authority = 'claim-2';
  assert.equal(await recover(event, 'claim-1'), false);
});
