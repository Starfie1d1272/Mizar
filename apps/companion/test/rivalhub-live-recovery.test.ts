import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'connection.json');
  const snapshot = parseLiveSnapshotV1(
    JSON.parse(
      await readFile(
        new URL('../../../packages/protocol/test/fixtures/live-snapshot-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  snapshot.cursor.liveSessionId = 'session-1';
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
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: 'https://example.com',
      credential: 'fixture',
      installationId: 'installation',
      competitionId: snapshot.competitionId,
      displayName: 'fixture',
    }),
  );
  let now = 0;
  let behavior: () => Response | Promise<Response> = () => Response.json({ accepted: true });
  let reliableBehavior: () => Response | Promise<Response> = () =>
    new Response(null, { status: 204 });
  const sent: number[] = [];
  const connection = new RivalHubConnection(
    path,
    async (input, init) => {
      const url = String(input);
      if (url.endsWith('/claim')) return Response.json({ claimed: true, authorityRevision: 1 });
      if (url.endsWith('/reliable')) return reliableBehavior();
      assert.ok(url.endsWith('/live'));
      assert.equal(init?.redirect, 'manual');
      sent.push(JSON.parse(String(init?.body)).cursor.runtimeSeq);
      return behavior();
    },
    'https://example.com',
    () => now,
  );
  await connection.load();
  await connection.claim(snapshot, 'revision-1', false);
  assert.equal(await connection.sendReliable(event, snapshot), 'accepted');
  return {
    connection,
    snapshot,
    event,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
    behavior: (fn: () => Response | Promise<Response>) => {
      behavior = fn;
    },
    reliableBehavior: (fn: () => Response | Promise<Response>) => {
      reliableBehavior = fn;
    },
  };
}

for (const failure of ['reset', 'timeout', 'server', 'certificate', 'broadcast'] as const) {
  test(`LIVE ${failure} uses its recovery budget and resumes with the latest frame`, async (t) => {
    const h = await setup(t);
    h.behavior(() => {
      if (failure === 'server') return new Response(null, { status: 503 });
      if (failure === 'broadcast')
        return Response.json({ accepted: false, reason: 'broadcast_unavailable' });
      if (failure === 'timeout') throw Object.assign(new Error(), { name: 'TimeoutError' });
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(), {
          code: failure === 'reset' ? 'ECONNRESET' : 'CERT_HAS_EXPIRED',
        }),
      });
    });
    const fast = failure === 'reset' || failure === 'timeout';
    for (const delay of fast ? [1000, 2000, 2000] : [1000, 2000, 4000, 8000]) {
      const before = h.sent.length;
      await h.connection.sendLive(h.snapshot);
      assert.equal(h.sent.length, before + 1);
      h.advance(delay - 1);
      await h.connection.sendLive(h.snapshot);
      assert.equal(h.sent.length, before + 1);
      h.advance(1);
    }
    h.behavior(() => Response.json({ accepted: true }));
    h.snapshot.cursor.runtimeSeq = 100;
    await h.connection.sendLive(h.snapshot);
    assert.equal(h.sent.at(-1), 100);
    h.snapshot.cursor.runtimeSeq = 101;
    await h.connection.sendLive(h.snapshot);
    assert.equal(h.sent.at(-1), 101);
  });
}

test('new map clears old delay but still waits for its reliable start ACK', async (t) => {
  const h = await setup(t);
  h.behavior(() => new Response(null, { status: 503 }));
  await h.connection.sendLive(h.snapshot);
  const next = structuredClone(h.snapshot);
  next.cursor.mapEpoch += 1;
  await assert.rejects(h.connection.sendLive(next), /map_start_pending/);
  assert.equal(h.sent.length, 1);
  assert.equal(
    await h.connection.sendReliable(
      { ...h.event, cursor: next.cursor, idempotencyKey: 'next-start' },
      next,
    ),
    'accepted',
  );
  h.behavior(() => Response.json({ accepted: true }));
  await h.connection.sendLive(next);
  assert.equal(h.sent.length, 2);
});

test('old in-flight failure cannot delay the next execution', async (t) => {
  const h = await setup(t);
  let fail!: () => void;
  h.behavior(
    () =>
      new Promise<Response>((_resolve, reject) => {
        fail = () =>
          reject(
            new TypeError('fetch failed', {
              cause: Object.assign(new Error(), { code: 'ECONNRESET' }),
            }),
          );
      }),
  );
  const pending = h.connection.sendLive(h.snapshot);
  const next = structuredClone(h.snapshot);
  next.cursor.mapEpoch += 1;
  assert.equal(
    await h.connection.sendReliable(
      { ...h.event, cursor: next.cursor, idempotencyKey: 'next-start' },
      next,
    ),
    'accepted',
  );
  fail();
  await assert.rejects(pending, /live_unavailable/);
  h.behavior(() => Response.json({ accepted: true }));
  await h.connection.sendLive(next);
  assert.equal(h.sent.length, 2);
});

test('reliable rejection preserves only classified bounded metadata and safely handles old servers', async (t) => {
  const h = await setup(t);
  const requestId = 'c8f5fa6d-e075-470d-a3d4-fc24ce646fa5';
  h.reliableBehavior(() =>
    Response.json(
      {
        error: 'unsafe untrusted text',
        code: 'old',
        reason: 'context_stale',
        requestId,
        recovery: 'refresh_context',
      },
      { status: 400 },
    ),
  );
  assert.deepEqual(await h.connection.sendReliable(h.event, h.snapshot), {
    status: 'rejected',
    reason: 'context_stale',
    requestId,
    recovery: 'refresh_context',
  });
  h.reliableBehavior(() => Response.json({ error: 'old server' }, { status: 400 }));
  assert.equal(await h.connection.sendReliable(h.event, h.snapshot), 'rejected');
  h.reliableBehavior(() =>
    Response.json({ reason: 'context_stale', requestId, recovery: 'reconcile' }, { status: 400 }),
  );
  assert.equal(await h.connection.sendReliable(h.event, h.snapshot), 'rejected');
  h.reliableBehavior(() => new Response('x'.repeat(4097), { status: 400 }));
  assert.equal(await h.connection.sendReliable(h.event, h.snapshot), 'rejected');
  h.reliableBehavior(() => new Response(null, { status: 503 }));
  assert.equal(await h.connection.sendReliable(h.event, h.snapshot), 'retry');
});
