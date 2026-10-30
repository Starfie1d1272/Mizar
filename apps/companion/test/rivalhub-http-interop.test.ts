/** Opt-in: requires the disposable RivalHub HTTP fixture and loopback PostgreSQL. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

    const makeConnection = async (
      index: number,
      fetcher: typeof fetch = fetch,
      snapshotForSink: ReturnType<typeof parseLiveSnapshotV1> | null = null,
      name = `producer-${index}`,
    ) => {
      const p = manifest.producers[index]!;
      const path = join(temp, name, 'connection.json');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(temp, name));
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
      const outbox = new ReliableOutbox(join(temp, name, 'outbox.json'));
      const output = new OutputService({
        outbox,
        sink: {
          send: (event, signal, lineup) =>
            connection.sendReliable(event, snapshotForSink, signal, lineup),
        },
      });
      // Load the actual durable owner without a background tick, so the test
      // controls when an already queued tail becomes eligible for delivery.
      await outbox.load();
      t.after(() => output.close());
      connection.setSourceSettlement(
        (scope) => output.settleSourceForRelease(scope),
        (scope) => output.resumeSource(scope),
      );
      return { connection, output, outbox, path };
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
        const { connection, output, outbox } = await makeConnection(0, realFetch, snapshot);
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
        const tail = parseReliableEventV1({
          ...start,
          kind: 'series_ended',
          payload: { scoreA: 2, scoreB: 0 },
          observedAt: new Date().toISOString(),
          idempotencyKey: randomUUID(),
          cursor: { ...start.cursor, runtimeSeq: start.cursor.runtimeSeq + 1 },
        });
        const binding = {
          origin: 'online',
          freshness: 'fresh',
          manifest: { revision: contextRevision },
          context: {
            matchId: tail.matchId,
            competition: { competitionId: tail.competitionId },
            entrants: { a: { entryId: tail.entryAId }, b: { entryId: tail.entryBId } },
          },
        };
        const bundle = {
          program: {
            cursor: snapshot.cursor,
            match: { matchId: tail.matchId },
            status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
            map: { phase: 'gameover', name: tail.mapName },
            players: snapshot.players,
            series: { status: 'completed', currentMapOrder: 1, maps: [] },
          },
          operator: { activeLineup: { ctCount: 5, tCount: 5 }, identity: { state: 'ok' } },
          identity: { issues: [] },
        };
        output.setCurrent(bundle as never, binding as never);
        await outbox.enqueue(tail, new Date());
        assert.equal(
          outbox.getRecords().find((record) => record.event.idempotencyKey === tail.idempotencyKey)
            ?.status,
          'pending',
        );
        await db.query(
          "update matches set status='finished', completed_at=now(), score_a=2, score_b=0 where id=$1 and season_id=$2",
          [p.fixture.matchId, p.fixture.seasonId],
        );
        snapshot.producedAt = new Date().toISOString();
        await assert.rejects(connection.sendLive(snapshot));
        assert.ok(
          statuses.some((entry) => entry.operation.endsWith('/live') && entry.status === 403),
        );
        const reliableBefore = statuses.filter((entry) =>
          entry.operation.endsWith('/reliable'),
        ).length;
        assert.equal(await connection.sendReliable(tail, snapshot), 'retry');
        assert.equal(
          statuses.filter((entry) => entry.operation.endsWith('/reliable')).length,
          reliableBefore,
        );
        const app = Fastify();
        const scenes = {
          get: () => ({ active: 'waiting', revision: 'scene' }),
          holdAutomatic: () => undefined,
          controlValid: () => () => true,
          selectWaitingForExit: async () => ({ ok: true }),
        } as unknown as ProgramSceneController;
        let restorationAttempts = 0;
        const production = registerProductionRoutes(app, {
          originPolicy: createLocalWebOriginPolicy(),
          hasContext: () => true,
          scenes,
          afterSafeScene: () => {
            restorationAttempts++;
            throw new Error('synthetic video restoration deferred');
          },
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
          assert.equal(restorationAttempts, 1);
          assert.equal(
            outbox
              .getRecords()
              .find((record) => record.event.idempotencyKey === tail.idempotencyKey)?.status,
            'accepted',
          );
          assert.equal(
            statuses.filter(
              (entry) => entry.operation.endsWith('/reliable') && entry.status === 200,
            ).length,
            reliableBefore + 1,
          );
          const tailIndex = statuses
            .map((entry) => entry.operation.endsWith('/reliable'))
            .lastIndexOf(true);
          const releaseIndex = statuses.findIndex((entry) => entry.operation.endsWith('/release'));
          assert.ok(tailIndex >= 0 && releaseIndex > tailIndex);
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

    await t.test('an explicit stale-context rejection permits a fresh claim', async () => {
      const p = manifest.producers[1]!;
      const snapshot = parseLiveSnapshotV1(p.liveTemplate);
      snapshot.cursor.producerInstanceId = randomUUID();
      snapshot.cursor.liveSessionId = randomUUID();
      const claimStatuses: number[] = [];
      const observeFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (new URL(String(input)).pathname.endsWith('/claim')) claimStatuses.push(response.status);
        return response;
      };
      const { connection } = await makeConnection(1, observeFetch, null, 'stale-claim');
      await assert.rejects(connection.claim(snapshot, 'stale-context', true));
      assert.deepEqual(claimStatuses, [400]);
      assert.equal(connection.view().sourceCleanup.claimIntent, false);
      const absent = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
      );
      assert.equal(absent.status, 'not_found');
      await connection.claim(snapshot, await revision(1), true);
      assert.deepEqual(claimStatuses, [400, 200]);
      const claimed = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
      );
      assert.equal(claimed.source?.state, 'open');
      await connection.release();
      const released = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
        claimed.source!.authorityRevision,
      );
      assert.equal(released.source?.state, 'closed');
    });

    for (const delayedStatus of [false, true]) {
      await t.test(
        `lost idempotent claim is reconciled with ${delayedStatus ? 'closed' : 'open'} exact status`,
        async () => {
          const p = manifest.producers[1]!;
          const snapshot = parseLiveSnapshotV1(p.liveTemplate);
          snapshot.cursor.producerInstanceId = randomUUID();
          snapshot.cursor.liveSessionId = randomUUID();
          let dropRepeat = false;
          let hideStatus = false;
          let dropRelease = !delayedStatus;
          let successfulClaims = 0;
          const realFetch: typeof fetch = async (input, init) => {
            const response = await fetch(input, init);
            const pathname = new URL(String(input)).pathname;
            if (pathname.endsWith('/claim') && response.ok) {
              successfulClaims++;
              if (dropRepeat) {
                dropRepeat = false;
                await response.body?.cancel();
                throw new TypeError('lost repeated claim response after server commit');
              }
            }
            if (pathname.endsWith('/source-status') && hideStatus && response.ok) {
              await response.body?.cancel();
              return Response.json({ status: 'ambiguous' });
            }
            if (pathname.endsWith('/release') && response.ok && dropRelease) {
              dropRelease = false;
              await response.body?.cancel();
              throw new TypeError('lost release response after server commit');
            }
            return response;
          };
          const { connection, output, path } = await makeConnection(
            1,
            realFetch,
            null,
            `repeat-${delayedStatus}`,
          );
          const context = await revision(1);
          await connection.claim(snapshot, context, true);
          const initial = await status(
            1,
            snapshot.cursor.producerInstanceId,
            snapshot.cursor.liveSessionId!,
          );
          assert.equal(initial.source?.state, 'open');
          dropRepeat = true;
          await assert.rejects(connection.claim(snapshot, context, false));
          const repeated = await status(
            1,
            snapshot.cursor.producerInstanceId,
            snapshot.cursor.liveSessionId!,
          );
          assert.equal(repeated.source?.state, 'open');
          assert.equal(repeated.source?.authorityRevision, initial.source?.authorityRevision);
          assert.equal(successfulClaims, 2);
          hideStatus = delayedStatus;
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
            initial.source!.authorityRevision,
          );
          assert.equal(closed.source?.state, 'closed');
          if (delayedStatus) assert.equal(restarted.view().sourceCleanup.claimIntent, true);
          hideStatus = false;
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
          await again.claim(snapshot, await revision(1), false);
          await again.release();
        },
      );
    }

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

    await t.test('a killed process recovers its committed claim through exact status', async () => {
      const p = manifest.producers[1]!;
      const snapshot = parseLiveSnapshotV1(p.liveTemplate);
      snapshot.cursor.producerInstanceId = randomUUID();
      snapshot.cursor.liveSessionId = randomUUID();
      const path = join(temp, 'producer-1', 'connection.json');
      const childInput = join(temp, 'kill-claim.json');
      const childScript = join(temp, 'kill-claim.mjs');
      await writeFile(
        childInput,
        JSON.stringify({
          snapshot,
          revision: await revision(1),
          path,
          baseUrl: siteAddress.origin,
        }),
        { mode: 0o600 },
      );
      await writeFile(
        childScript,
        `
        import { readFile } from 'node:fs/promises';
        import { RivalHubConnection } from ${JSON.stringify(new URL('../src/match-context/rivalhub-connection.ts', import.meta.url).href)};
        const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
        const receiver = async (url, init) => {
          const response = await fetch(url, init);
          if (new URL(String(url)).pathname.endsWith('/claim')) {
            if (!response.ok) throw new Error('local claim failed');
            await response.body?.cancel();
            process.stdout.write('CLAIM_COMMITTED\\n');
            return await new Promise(() => { setInterval(() => {}, 1000); });
          }
          return response;
        };
        const connection = new RivalHubConnection(input.path, receiver, input.baseUrl);
        await connection.load();
        await connection.claim(input.snapshot, input.revision, true);
      `,
        { mode: 0o600 },
      );
      const tsxLoader = createRequire(import.meta.url).resolve('tsx/esm');
      const child = spawn(process.execPath, ['--import', tsxLoader, childScript, childInput], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr.resume();
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        },
      );
      const committed = new Promise<void>((resolve) => {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (chunk.includes('CLAIM_COMMITTED')) resolve();
        });
      });
      try {
        await Promise.race([
          committed,
          exited.then(() => {
            throw new Error('child exited before claim commit');
          }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('claim commit timed out')), 15_000);
            timer.unref();
          }),
        ]);
        child.kill('SIGKILL');
        assert.equal((await exited).signal, 'SIGKILL');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      const before = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
      );
      assert.equal(before.source?.state, 'open');
      const restarted = new RivalHubConnection(path, fetch, siteAddress.origin);
      await restarted.load();
      const outbox = new ReliableOutbox(join(temp, 'killed-outbox.json'));
      const output = new OutputService({ outbox });
      await output.start();
      t.after(() => output.close());
      restarted.setSourceSettlement(
        (scope) => output.settleSourceForRelease(scope),
        (scope) => output.resumeSource(scope),
      );
      await restarted.release();
      const after = await status(
        1,
        snapshot.cursor.producerInstanceId,
        snapshot.cursor.liveSessionId!,
        before.source!.authorityRevision,
      );
      assert.equal(after.source?.state, 'closed');
      assert.equal(after.source?.closeReason, 'released');
    });

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
