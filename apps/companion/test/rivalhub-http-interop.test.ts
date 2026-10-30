/** Opt-in: requires the disposable RivalHub HTTP fixture and loopback PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import { OutputService } from '../src/output/service.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { buildApp } from '../src/app.js';
import type { ProgramSceneController } from '../src/program-scenes/controller.js';
import { registerProductionRoutes } from '../src/program-scenes/production.js';

const fixturePath = process.env.MIZAR_INTEROP_FIXTURE;
const databaseUrl = process.env.MIZAR_INTEROP_DATABASE;
const websiteUrl = process.env.MIZAR_INTEROP_WEBSITE;
const websiteRoot = process.env.MIZAR_INTEROP_WEBSITE_ROOT;

test(
  'actual RivalHub HTTP and PostgreSQL preserve source cleanup across finish and lost responses',
  { skip: !fixturePath },
  async (t) => {
    assert.ok(fixturePath && databaseUrl && websiteUrl && websiteRoot);
    const dbAddress = new URL(databaseUrl);
    const siteAddress = new URL(websiteUrl);
    assert.equal(dbAddress.hostname, '127.0.0.1');
    assert.equal(dbAddress.port, '55439');
    assert.equal(siteAddress.origin, 'http://127.0.0.1:3107');
    const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      schemaVersion: string;
      fixtureId: string;
      producers: Array<{
        credential: string;
        fixture: {
          matchId: string;
          seasonId: string;
          installationId: string;
          sessionId: string;
          contextRevision: string;
        };
        liveTemplate: unknown;
        reliableEnvelope: { event: Record<string, unknown> };
      }>;
    };
    assert.equal(manifest.schemaVersion, 'rivalhub.local-mizar-http-resource.v1');
    assert.equal(manifest.producers.length, 2);
    const pg = createRequire(resolve(websiteRoot, 'package.json'))('pg') as {
      Client: new (input: { connectionString: string; ssl: false }) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      };
    };
    const db = new pg.Client({ connectionString: databaseUrl, ssl: false });
    await db.connect();
    t.after(() => db.end());
    const temp = await mkdtemp(join(tmpdir(), 'mizar-http-interop-'));
    t.after(() => rm(temp, { recursive: true, force: true }));

    const makeConnection = async (index: number, fetcher: typeof fetch = fetch) => {
      const p = manifest.producers[index]!;
      const path = join(temp, `producer-${index}`, 'connection.json');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(temp, `producer-${index}`));
      await writeFile(
        path,
        JSON.stringify({
          baseUrl: siteAddress.origin,
          credential: p.credential,
          installationId: p.fixture.installationId,
          competitionId: p.fixture.seasonId,
          displayName: 'local fixture',
        }),
        { mode: 0o600 },
      );
      const connection = new RivalHubConnection(path, fetcher, siteAddress.origin);
      await connection.load();
      const outbox = new ReliableOutbox(join(temp, `producer-${index}`, 'outbox.json'));
      const output = new OutputService({ outbox });
      await output.start();
      t.after(() => output.close());
      connection.setSourceSettlement(
        (scope) => output.settleSourceForRelease(scope),
        (scope) => output.resumeSource(scope),
      );
      return { connection, output, path };
    };
    const revision = async (index: number) => {
      const p = manifest.producers[index]!;
      const response = await fetch(
        `${siteAddress.origin}/api/mizar/match?matchId=${p.fixture.matchId}`,
        { headers: { authorization: `Bearer ${p.credential}` } },
      );
      assert.equal(response.status, 200);
      const value = (await response.json()) as { revision: string };
      return value.revision;
    };
    const status = async (index: number, producer: string, live: string, authority?: number) => {
      const p = manifest.producers[index]!;
      const query = new URLSearchParams({
        matchId: p.fixture.matchId,
        producerInstanceId: producer,
        liveSessionId: live,
      });
      if (authority !== undefined) query.set('authorityRevision', String(authority));
      const response = await fetch(`${siteAddress.origin}/api/mizar/source-status?${query}`, {
        headers: { authorization: `Bearer ${p.credential}` },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return (await response.json()) as {
        status: string;
        source?: { state: string; authorityRevision: number; closeReason: string | null };
      };
    };
    for (let i = 0; i < manifest.producers.length; i++) {
      const p = manifest.producers[i]!;
      const rows = await db.query(
        'select s.slug from seasons s join matches m on m.season_id=s.id where m.id=$1 and s.id=$2',
        [p.fixture.matchId, p.fixture.seasonId],
      );
      assert.equal(rows.rows[0]?.slug, `mizar-http-${manifest.fixtureId}-${i + 1}`);
    }

    await t.test(
      'finished match rejects LIVE and production finish releases its exact source',
      async () => {
        const p = manifest.producers[0]!;
        const snapshot = parseLiveSnapshotV1(p.liveTemplate);
        const contextRevision = await revision(0);
        const statuses: Array<{ operation: string; status: number }> = [];
        const realFetch: typeof fetch = async (input, init) => {
          const response = await fetch(input, init);
          statuses.push({ operation: new URL(String(input)).pathname, status: response.status });
          return response;
        };
        const { connection } = await makeConnection(0, realFetch);
        await connection.claim(snapshot, contextRevision, false);
        const start = parseReliableEventV1({
          ...p.reliableEnvelope.event,
          contextRevision,
          idempotencyKey: randomUUID(),
          observedAt: new Date().toISOString(),
          kind: 'map_started',
          payload: {},
          cursor: snapshot.cursor,
        });
        const outcome = await connection.sendReliable(start, snapshot);
        assert.ok(
          outcome === 'accepted' || (typeof outcome === 'object' && outcome.status === 'accepted'),
        );
        const before = await status(
          0,
          snapshot.cursor.producerInstanceId,
          snapshot.cursor.liveSessionId!,
          1,
        );
        assert.equal(before.source?.state, 'open');
        const otherSnapshot = parseLiveSnapshotV1(manifest.producers[1]!.liveTemplate);
        const otherBefore = await status(
          1,
          otherSnapshot.cursor.producerInstanceId,
          otherSnapshot.cursor.liveSessionId!,
        );
        assert.equal(otherBefore.source?.state, 'open');
        const crossQuery = new URLSearchParams({
          matchId: manifest.producers[1]!.fixture.matchId,
          producerInstanceId: otherSnapshot.cursor.producerInstanceId,
          liveSessionId: otherSnapshot.cursor.liveSessionId!,
        });
        const crossResponse = await fetch(
          `${siteAddress.origin}/api/mizar/source-status?${crossQuery}`,
          {
            headers: { authorization: `Bearer ${p.credential}` },
          },
        );
        assert.equal(crossResponse.status, 200);
        assert.equal(((await crossResponse.json()) as { status: string }).status, 'not_found');
        await db.query(
          "update matches set status='finished', completed_at=now() where id=$1 and season_id=$2",
          [p.fixture.matchId, p.fixture.seasonId],
        );
        snapshot.producedAt = new Date().toISOString();
        await assert.rejects(connection.sendLive(snapshot));
        assert.ok(
          statuses.some((entry) => entry.operation.endsWith('/live') && entry.status === 403),
        );
        const app = Fastify();
        const scenes = {
          get: () => ({ active: 'waiting', revision: 'scene' }),
          holdAutomatic: () => undefined,
          controlValid: () => () => true,
          selectWaitingForExit: async () => ({ ok: true }),
        } as unknown as ProgramSceneController;
        const production = registerProductionRoutes(app, {
          originPolicy: createLocalWebOriginPolicy(),
          hasContext: () => true,
          scenes,
          release: () => connection.release(),
        });
        await app.listen({ host: '127.0.0.1', port: 0 });
        try {
          const base = app.addresses()[0];
          assert.ok(base && typeof base === 'object');
          const url = `http://127.0.0.1:${base.port}/operator/production`;
          const command = (action: string, expectedRevision: string) =>
            fetch(url, {
              method: 'POST',
              headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
              body: JSON.stringify({ action, expectedRevision }),
            });
          const entered = await command('enter', production.get().revision);
          assert.equal(entered.status, 200);
          const finished = await command('finish', production.get().revision);
          assert.equal(finished.status, 200);
          const after = await status(
            0,
            snapshot.cursor.producerInstanceId,
            snapshot.cursor.liveSessionId!,
            1,
          );
          assert.equal(after.source?.state, 'closed');
          assert.equal(after.source?.closeReason, 'released');
          const otherAfter = await status(
            1,
            otherSnapshot.cursor.producerInstanceId,
            otherSnapshot.cursor.liveSessionId!,
          );
          assert.equal(otherAfter.source?.state, 'open');
          assert.ok(
            statuses.some((entry) => entry.operation.endsWith('/release') && entry.status === 200),
          );
        } finally {
          await app.close();
        }
      },
    );

    await t.test(
      'claim and release responses lost after commit are recovered with real status and idempotent release',
      async () => {
        const p = manifest.producers[1]!;
        const snapshot = parseLiveSnapshotV1(p.liveTemplate);
        snapshot.cursor.producerInstanceId = randomUUID();
        snapshot.cursor.liveSessionId = randomUUID();
        let dropClaim = true;
        let dropRelease = true;
        const realFetch: typeof fetch = async (input, init) => {
          const response = await fetch(input, init);
          const path = new URL(String(input)).pathname;
          if (
            response.ok &&
            ((path.endsWith('/claim') && dropClaim) || (path.endsWith('/release') && dropRelease))
          ) {
            if (path.endsWith('/claim')) dropClaim = false;
            else dropRelease = false;
            await response.body?.cancel();
            throw new TypeError('synthetic loss after actual server commit');
          }
          return response;
        };
        const { connection, output, path } = await makeConnection(1, realFetch);
        await assert.rejects(connection.claim(snapshot, await revision(1), true));
        const owned = await status(
          1,
          snapshot.cursor.producerInstanceId,
          snapshot.cursor.liveSessionId!,
        );
        assert.equal(owned.status, 'found');
        assert.equal(owned.source?.state, 'open');
        const restarted = new RivalHubConnection(path, realFetch, siteAddress.origin);
        await restarted.load();
        restarted.setSourceSettlement(
          (scope) => output.settleSourceForRelease(scope),
          (scope) => output.resumeSource(scope),
        );
        await assert.rejects(restarted.release());
        const closed = await status(
          1,
          snapshot.cursor.producerInstanceId,
          snapshot.cursor.liveSessionId!,
          owned.source!.authorityRevision,
        );
        assert.equal(closed.source?.state, 'closed');
        assert.equal(closed.source?.closeReason, 'released');
        const again = new RivalHubConnection(path, realFetch, siteAddress.origin);
        await again.load();
        again.setSourceSettlement(
          (scope) => output.settleSourceForRelease(scope),
          (scope) => output.resumeSource(scope),
        );
        await again.release();
        assert.deepEqual(again.view().sourceCleanup, {
          pending: 0,
          blocked: 0,
          claimIntent: false,
        });
      },
    );

    await t.test('Companion onClose releases the source over real HTTP', async () => {
      const p = manifest.producers[1]!;
      const snapshot = parseLiveSnapshotV1(p.liveTemplate);
      snapshot.cursor.producerInstanceId = randomUUID();
      snapshot.cursor.liveSessionId = randomUUID();
      const path = join(temp, 'producer-1', 'connection.json');
      const connection = new RivalHubConnection(path, fetch, siteAddress.origin);
      await connection.load();
      await connection.claim(snapshot, await revision(1), false);
      const before = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
      );
      assert.equal(before.source?.state, 'open');
      const app = buildApp({
        rivalhubConnection: connection,
        reliableOutboxPath: join(temp, 'app-outbox.json'),
      });
      await app.ready();
      await app.close();
      const after = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
        before.source!.authorityRevision,
      );
      assert.equal(after.source?.state, 'closed');
      assert.equal(after.source?.closeReason, 'released');
    });
  },
);
