import * as filesystem from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  sealDiagnosticGzip,
  readDiagnosticGzipPermit,
} from '../../packages/protocol/src/diagnostics-upload.js';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import {
  DiagnosticDelivery,
  decodeDiagnosticBatch,
} from '../../apps/companion/src/support/delivery.js';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { runtime, migrate, bindings, script, adminHeaders, hash } from './fixture.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

async function sealedFixture(bytes: Uint8Array, issue: (id: string) => Promise<Response>) {
  const response = await issue(hash(bytes));
  expect(response.status).toBe(200);
  return Buffer.from(
    sealDiagnosticGzip(
      bytes,
      (await response.json()) as import('../../packages/protocol/src/diagnostics-upload.js').DiagnosticUploadPermit,
    ),
  );
}
it('delivers the real disk outbox over HTTP into Worker/R2/D1; recovers lost ACK across both restarts; reads causes, expires and revokes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-real-'));
  let mf = runtime(join(directory, 'server'));
  const client = join(directory, 'client');
  let journal = new SessionJournal(client, { appVersion: '1.4.0' });
  let now = Date.now();
  let endpoint = (await mf.ready).origin;
  let loseAck = false;
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cf-connecting-ip', '127.0.0.1');
    const response = await fetch(input, { ...init, headers });
    if (loseAck && init?.method === 'PUT' && response.ok) {
      loseAck = false;
      await response.arrayBuffer();
      throw new TypeError('synthetic lost receipt after durable commit');
    }
    return response;
  };
  let delivery = new DiagnosticDelivery(client, journal, {
    endpoint,
    allowTestEndpoint: true,
    fetch: fetcher,
    now: () => now,
  });
  try {
    await migrate(await mf.getD1Database('DIAGNOSTICS_DB'));
    await delivery.initialize(false);
    await delivery.consent(true);
    journal.record('workspace_exit_begin', {
      actualArguments: ['-applaunch', '730', '-worldwide'],
      before: { workspace: 'active' },
    });
    journal.record('workspace_exit_failure', {
      phase: 'restore_window',
      error: new Error('outer token=PRIVATE-CLOUD', {
        cause: Object.assign(new Error('original window restore denied'), { code: 'EACCES' }),
      }),
      after: { workspace: 'waiting' },
    });
    await journal.flush();
    loseAck = true;
    await delivery.tick();
    expect(delivery.status()).toMatchObject({ queuedBatches: 1, acknowledged: 0, failures: 1 });
    const state = JSON.parse(
      await readFile(join(client, 'diagnostic-outbox', 'state.json'), 'utf8'),
    ) as { credentials: { installationId: string }; queue: { id: string }[] };
    const installation = state.credentials.installationId;
    const id = state.queue[0]!.id;
    const first = await (
      await mf.getD1Database('DIAGNOSTICS_DB')
    )
      .prepare('SELECT * FROM batches WHERE id=?')
      .bind(id)
      .first<{ object_key: string; state: string }>();
    expect(first?.state).toBe('ready');
    const stored = await (await mf.getR2Bucket('DIAGNOSTICS_BUCKET')).get(first!.object_key);
    const gzip = new Uint8Array(await stored!.arrayBuffer());
    expect(hash(gzip)).toBe(id);
    const decoded = JSON.stringify(await decodeDiagnosticBatch(Buffer.from(gzip)));
    for (const expected of ['original window restore denied', 'EACCES', '-worldwide', 'waiting'])
      expect(decoded).toContain(expected);
    expect(decoded).not.toContain('PRIVATE-CLOUD');
    const uploadedAt = stored!.uploaded.getTime();
    await delivery.close();
    await journal.close();
    await mf.dispose();
    mf = runtime(join(directory, 'server'));
    endpoint = (await mf.ready).origin;
    now += 60_000;
    journal = new SessionJournal(client, { appVersion: '1.4.0' });
    delivery = new DiagnosticDelivery(client, journal, {
      endpoint,
      allowTestEndpoint: true,
      fetch: fetcher,
      now: () => now,
    });
    await delivery.initialize(false);
    await delivery.tick();
    expect(delivery.status().acknowledged).toBe(1);
    const db = await mf.getD1Database('DIAGNOSTICS_DB');
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS count FROM batches WHERE id=?')
          .bind(id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (await (
        await mf.getR2Bucket('DIAGNOSTICS_BUCKET')
      ).head(first!.object_key))!.uploaded.getTime(),
    ).toBe(uploadedAt);
    const search = await fetch(`${endpoint}/admin/sessions?installation=${installation}`, {
      headers: adminHeaders,
    });
    expect(search.status).toBe(200);
    const index = await search.text();
    expect(index).toContain(installation);
    expect(index).not.toContain('original window restore denied');
    const body = await fetch(`${endpoint}/admin/bodies/${installation}/${id}`, {
      headers: adminHeaders,
    });
    expect(body.status).toBe(200);
    expect(hash(new Uint8Array(await body.arrayBuffer()))).toBe(id);
    expect((await fetch(`${endpoint}/admin/sessions`)).status).toBe(401);
    expect(
      (
        await fetch(`${endpoint}/admin/sessions`, {
          headers: { ...adminHeaders, origin: 'https://untrusted.invalid' },
        })
      ).status,
    ).toBe(403);
    await db
      .prepare('UPDATE batches SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1, id)
      .run();
    expect(
      (await fetch(`${endpoint}/admin/bodies/${installation}/${id}`, { headers: adminHeaders }))
        .status,
    ).toBe(404);
    const bucket = await mf.getR2Bucket('DIAGNOSTICS_BUCKET');
    expect(await bucket.head(first!.object_key)).not.toBeNull();
    expect(
      (await fetch(`${endpoint}/admin/cleanup`, { method: 'POST', headers: adminHeaders })).status,
    ).toBe(200);
    expect(await bucket.head(first!.object_key)).toBeNull();
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS count FROM sessions WHERE installation_id=?')
          .bind(installation)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    await delivery.consent(false);
    await delivery.tick();
    expect(delivery.status().deletionPending).toBe(0);
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS count FROM sessions WHERE installation_id=?')
          .bind(installation)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await db
          .prepare('SELECT revoked_at FROM installations WHERE id=?')
          .bind(installation)
          .first<{ revoked_at: number }>()
      )?.revoked_at,
    ).toBeGreaterThan(0);
  } finally {
    await delivery.close();
    await journal.close();
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('keeps deletion pending during a real R2 write and completes after the writer settles, without reviving the installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-race-'));
  const mf = runtime(directory);
  const { handle } = (await import(
    `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`
  )) as { handle: (request: Request, env: unknown, now?: number) => Promise<Response> };
  let failPut = true;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const bucket = await mf.getR2Bucket('DIAGNOSTICS_BUCKET');
  const db = await mf.getD1Database('DIAGNOSTICS_DB');
  await migrate(db);
  const env = {
    ...bindings,
    DIAGNOSTICS_DB: db,
    DIAGNOSTICS_BUCKET: new Proxy(bucket, {
      get(target, property) {
        if (property === 'put')
          return async (...args: Parameters<typeof bucket.put>) => {
            if (failPut) {
              failPut = false;
              throw new Error('synthetic R2 unavailable');
            }
            entered();
            await gate;
            return bucket.put(...args);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (...args: unknown[]) => Reflect.apply(value, target, args) as unknown
          : value;
      },
    }),
    ENROLL_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    UPLOAD_LIMITER: { limit: () => Promise.resolve({ success: true }) },
  };
  const call = (path: string, init: RequestInit) =>
    handle(
      new Request(`https://local.invalid${path}`, {
        ...init,
        headers: { 'cf-connecting-ip': '127.0.0.1', ...init.headers },
      }),
      env,
    );
  try {
    const installation = randomUUID();
    const enrollment = {
      consent: 'technical-diagnostics-v2',
      enrollmentId: installation,
      enrollmentSecret: 'a'.repeat(64),
    };
    const enrolled = await call('/v1/diagnostics/enroll', {
      method: 'POST',
      body: JSON.stringify(enrollment),
    });
    expect(enrolled.status).toBe(200);
    const identity = (await enrolled.json()) as { token: string };
    const issue = (id: string) =>
      call(`/v1/diagnostics/permits/${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${identity.token}` },
      });
    const bytes = await sealedFixture(
      gzipSync(
        JSON.stringify({
          schema: 'mizar-technical-diagnostics/1',
          events: [{ stage: 'public_failure', evidence: { cause: 'real storage race' } }],
        }),
      ),
      issue,
    );
    const payloadId = readDiagnosticGzipPermit(bytes)!.permit.payloadSha256;
    const permitUsage = await db.prepare('SELECT permits FROM daily').first();
    env.DAILY_BATCHES = '0';
    expect((await issue(payloadId)).status).toBe(200);
    expect((await issue('f'.repeat(64))).status).toBe(429);
    env.DAILY_BATCHES = bindings.DAILY_BATCHES;
    env.INSTALLATION_DAILY_BATCHES = '0';
    expect((await issue('f'.repeat(64))).status).toBe(429);
    env.INSTALLATION_DAILY_BATCHES = bindings.INSTALLATION_DAILY_BATCHES;
    expect(await db.prepare('SELECT permits FROM daily').first()).toEqual(permitUsage);
    const parallel = await Promise.all([issue('e'.repeat(64)), issue('e'.repeat(64))]);
    expect(parallel.map((response) => response.status)).toEqual([200, 200]);
    expect(await parallel[0].json()).toEqual(await parallel[1].json());
    expect(await db.prepare('SELECT permits FROM daily').first()).toMatchObject({ permits: 2 });
    expect(
      await db
        .prepare('SELECT quota_permits FROM installations WHERE id=?')
        .bind(installation)
        .first(),
    ).toMatchObject({ quota_permits: 2 });
    const id = hash(bytes);
    const upload = () =>
      call(`/v1/diagnostics/batches/${id}`, {
        method: 'PUT',
        body: bytes,
        headers: {
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/gzip',
          'x-content-sha256': id,
          'x-diagnostics-index': JSON.stringify({
            schema: 'mizar-technical-diagnostics/1',
            events: 1,
            expandedBytes: 128,
            stages: ['public_failure'],
          }),
        },
      });
    env.ACCEPTING = '0';
    expect((await upload()).status).toBe(503);
    expect(
      (
        await call('/v1/diagnostics/enroll', {
          method: 'POST',
          body: JSON.stringify({ ...enrollment, enrollmentId: randomUUID() }),
        })
      ).status,
    ).toBe(503);
    env.ACCEPTING = '1';
    env.DATABASE_BYTES = '0';
    const storagePaused = await upload();
    expect(storagePaused.status).toBe(503);
    expect(await storagePaused.json()).toMatchObject({ error: 'index_allocation_budget' });
    env.DATABASE_BYTES = bindings.DATABASE_BYTES;
    expect(
      (
        await call('/v1/diagnostics/enroll', {
          method: 'POST',
          body: JSON.stringify({ ...enrollment, enrollmentSecret: 'f'.repeat(64) }),
        })
      ).status,
    ).toBe(409);
    expect((await upload()).status).toBe(503);
    expect(
      await db.prepare('SELECT state,writers FROM batches WHERE id=?').bind(id).first(),
    ).toMatchObject({ state: 'failed', writers: 0 });
    expect((await bucket.list()).objects).toHaveLength(0);
    const uploading = upload();
    await started;
    const replaying = upload();
    await vi.waitFor(async () =>
      expect(
        await db.prepare('SELECT writers FROM batches WHERE id=?').bind(id).first(),
      ).toMatchObject({ writers: 2 }),
    );
    env.ACCEPTING = '0';
    env.DATABASE_BYTES = '0';
    const pending = await call('/v1/diagnostics/installation', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${identity.token}` },
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ deletion: 'pending', revoked: true });
    for (const kind of ['sessions', 'batches']) {
      const hidden = await call(`/admin/${kind}?installation=${installation}`, {
        headers: adminHeaders,
      });
      expect(await hidden.json()).toMatchObject({ [kind]: [] });
    }
    release();
    expect((await uploading).status).toBe(410);
    expect((await replaying).status).toBe(410);
    expect((await bucket.list()).objects).toHaveLength(0);
    const finished = await call('/v1/diagnostics/installation', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${identity.token}` },
    });
    expect(await finished.json()).toMatchObject({ deletion: 'complete', revoked: true });
    expect(
      (await call('/v1/diagnostics/enroll', { method: 'POST', body: JSON.stringify(enrollment) }))
        .status,
    ).toBe(200);
    expect(
      (
        await db
          .prepare('SELECT revoked_at FROM installations WHERE id=?')
          .bind(installation)
          .first<{ revoked_at: number }>()
      )?.revoked_at,
    ).toBeGreaterThan(0);
  } finally {
    release();
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('withholds ACK on a real D1 index failure, retries without resetting R2 TTL, rejects invalid bodies, and preserves an uncertain writer fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-faults-'));
  const mf = runtime(directory);
  try {
    const endpoint = (await mf.ready).origin;
    const db = await mf.getD1Database('DIAGNOSTICS_DB');
    await migrate(db);
    const installation = randomUUID();
    const enrolled = await fetch(`${endpoint}/v1/diagnostics/enroll`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '127.0.0.1' },
      body: JSON.stringify({
        consent: 'technical-diagnostics-v2',
        enrollmentId: installation,
        enrollmentSecret: 'b'.repeat(64),
      }),
    });
    expect(enrolled.status).toBe(200);
    const identity = (await enrolled.json()) as { token: string };
    const issue = (id: string) =>
      fetch(`${endpoint}/v1/diagnostics/permits/${id}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '127.0.0.1', authorization: `Bearer ${identity.token}` },
      });
    const bytes = await sealedFixture(
      gzipSync(
        JSON.stringify({
          schema: 'mizar-technical-diagnostics/1',
          events: [
            {
              stage: 'public_failure',
              evidence: { cause: 'original persisted SQLite failure context' },
            },
          ],
        }),
      ),
      issue,
    );
    const id = hash(bytes);
    const session = randomUUID();
    const stamp = new Date().toISOString();
    const index = {
      schema: 'mizar-technical-diagnostics/1',
      events: 1,
      expandedBytes: 256,
      stages: ['public_failure'],
      sessionId: session,
      from: stamp,
      to: stamp,
      version: '1.4.0',
      failures: 1,
    };
    const upload = (value: Uint8Array = bytes, metadata = index) =>
      fetch(`${endpoint}/v1/diagnostics/batches/${hash(value)}`, {
        method: 'PUT',
        headers: {
          'cf-connecting-ip': '127.0.0.1',
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/gzip',
          'x-content-sha256': hash(value),
          'x-diagnostics-index': JSON.stringify(metadata),
        },
        body: new Uint8Array(value),
      });
    // The wire SHA alone cannot substitute for a valid, installation-bound lifetime certificate.
    const opened = readDiagnosticGzipPermit(bytes)!;
    expect((await upload(opened.payload)).status).toBe(400);
    const badSignature = sealDiagnosticGzip(opened.payload, {
      ...opened.permit,
      signature: 'x'.repeat(43),
    });
    expect((await upload(badSignature)).status).toBe(400);
    expect(
      (
        await upload(
          sealDiagnosticGzip(opened.payload, { ...opened.permit, installationId: randomUUID() }),
        )
      ).status,
    ).toBe(400);
    const tamperedPayload = Uint8Array.from(bytes);
    tamperedPayload[tamperedPayload.length - 1] = tamperedPayload[tamperedPayload.length - 1]! ^ 1;
    expect((await upload(tamperedPayload)).status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM batches').first()).toMatchObject({
      count: 0,
    });
    // A real SQLite failure rolls back the session+ready transaction after the actual R2 put.
    await db.exec(
      "CREATE TRIGGER fail_index BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'synthetic index EIO'); END;",
    );
    expect((await upload()).status).toBe(503);
    const row = await db
      .prepare('SELECT * FROM batches WHERE id=?')
      .bind(id)
      .first<{ object_key: string; state: string; writers: number; expires_at: number }>();
    expect(row).toMatchObject({ state: 'failed', writers: 0 });
    const bucket = await mf.getR2Bucket('DIAGNOSTICS_BUCKET');
    const stored = await bucket.head(row!.object_key);
    expect(stored).not.toBeNull();
    expect(
      (await db.prepare('SELECT COUNT(*) AS count FROM sessions').first<{ count: number }>())
        ?.count,
    ).toBe(0);
    await db.exec('DROP TRIGGER fail_index;');
    expect((await upload()).status).toBe(200);
    const reorderedPermit = Object.fromEntries(
      Object.entries(opened.permit).reverse(),
    ) as unknown as import('../../packages/protocol/src/diagnostics-upload.js').DiagnosticUploadPermit;
    const alternateWire = sealDiagnosticGzip(opened.payload, reorderedPermit);
    expect(hash(alternateWire)).not.toBe(id);
    expect((await upload(alternateWire)).status).toBe(409);
    const oldRevision = Buffer.from(bytes);
    const revisionOffset = oldRevision.indexOf('technical-diagnostics-v2');
    expect(revisionOffset).toBeGreaterThan(0);
    oldRevision[revisionOffset + 'technical-diagnostics-v'.length] = 49;
    expect((await upload(oldRevision)).status).toBe(400);
    expect((await bucket.head(row!.object_key))!.uploaded.getTime()).toBe(
      stored!.uploaded.getTime(),
    );
    const summary = await db
      .prepare('SELECT * FROM sessions WHERE session_id=?')
      .bind(session)
      .first<{ events: number; failures: number; version: string; source_from: string }>();
    expect(summary).toMatchObject({ events: 1, failures: 1, version: '1.4.0', source_from: stamp });
    const before = await db.prepare('SELECT bytes,batches FROM daily').first();
    expect((await upload(bytes, { ...index, events: 99999 })).status).toBe(400);
    expect((await upload(Buffer.alloc(129 * 1024))).status).toBe(413);
    expect(await db.prepare('SELECT bytes,batches FROM daily').first()).toEqual(before);
    // Reproduce a crash after reserving, before any R2 object exists. A retry can
    // deliver the full body; it cannot manufacture proof that the old writer ended.
    const pendingBytes = await sealedFixture(
      gzipSync(
        JSON.stringify({
          schema: 'mizar-technical-diagnostics/1',
          events: [
            {
              stage: 'public_failure',
              evidence: { cause: 'full retry after unknown writer crash' },
            },
          ],
        }),
      ),
      issue,
    );
    const pendingId = hash(pendingBytes);
    const now = Date.now();
    const objectKey = `v1/${installation}/${Math.floor(now / 86400_000)}/${pendingId}.gz`;
    await db
      .prepare(
        "INSERT INTO batches(installation_id,id,object_key,owner,state,bytes,received_at,expires_at,metadata) VALUES(?,?,?,?,'pending',?,?,?,?)",
      )
      .bind(
        installation,
        pendingId,
        objectKey,
        randomUUID(),
        pendingBytes.length,
        now,
        now + 7 * 86400_000,
        JSON.stringify(index),
      )
      .run();
    expect((await upload(pendingBytes)).status).toBe(200);
    expect(
      await db.prepare('SELECT state,writers FROM batches WHERE id=?').bind(pendingId).first(),
    ).toMatchObject({ state: 'ready', writers: 1 });
    expect(hash(new Uint8Array(await (await bucket.get(objectKey))!.arrayBuffer()))).toBe(
      pendingId,
    );
    await db
      .prepare('UPDATE batches SET expires_at=?')
      .bind(Date.now() - 1)
      .run();
    const cleanup = await fetch(`${endpoint}/admin/cleanup`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toMatchObject({ unresolvedWriters: 1 });
    expect((await bucket.list()).objects).toHaveLength(0);
    expect(
      await db.prepare('SELECT metadata,writers FROM batches WHERE id=?').bind(pendingId).first(),
    ).toMatchObject({ metadata: '{}', writers: 1 });
    expect(await db.prepare('SELECT id FROM batches WHERE id=?').bind(id).first()).toBeNull();
    const withdrawal = await fetch(`${endpoint}/v1/diagnostics/installation`, {
      method: 'DELETE',
      headers: { 'cf-connecting-ip': '127.0.0.1', authorization: `Bearer ${identity.token}` },
    });
    expect(withdrawal.status).toBe(202);
    expect(await withdrawal.json()).toMatchObject({ revoked: true, deletion: 'pending' });
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('retrieves every indexed session and body locator across tied-timestamp pages and supports precise session/version/time/failure searches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-pages-'));
  const mf = runtime(directory);
  try {
    const endpoint = (await mf.ready).origin;
    const db = await mf.getD1Database('DIAGNOSTICS_DB');
    await migrate(db);
    const installation = randomUUID();
    await db
      .prepare('INSERT INTO installations(id,proof_sha256,created_at) VALUES(?,?,?)')
      .bind(installation, 'a'.repeat(64), Date.now())
      .run();
    const sessions = Array.from({ length: 102 }, () => randomUUID());
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    for (let offset = 0; offset < sessions.length; offset += 25) {
      await db.batch(
        sessions
          .slice(offset, offset + 25)
          .map((session) =>
            db
              .prepare(
                'INSERT INTO sessions(installation_id,session_id,first_received_at,last_received_at,source_from,source_to,version,events,failures,batches,bytes,expires_at) VALUES(?,?,?,?,?,?,?,1,1,1,128,?)',
              )
              .bind(installation, session, now, now, stamp, stamp, '1.4.0', now + 90 * 86400_000),
          ),
      );
      await db.batch(
        sessions.slice(offset, offset + 25).map((session, index) => {
          const id = hash(Buffer.from(session));
          return db
            .prepare(
              "INSERT INTO batches(installation_id,id,object_key,owner,state,writers,bytes,received_at,expires_at,metadata) VALUES(?,?,?,?,'ready',0,128,?,?,?)",
            )
            .bind(
              installation,
              id,
              `v1/${installation}/${id}.gz`,
              randomUUID(),
              now,
              now + 7 * 86400_000,
              JSON.stringify({ session, index }),
            );
        }),
      );
    }
    const seenSessions: string[] = [];
    const seenBodies: string[] = [];
    for (const kind of ['sessions', 'batches']) {
      let cursor: string | null = null;
      do {
        const response = await fetch(
          `${endpoint}/admin/${kind}?installation=${installation}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { headers: adminHeaders },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          sessions?: { session_id: string }[];
          batches?: { id: string }[];
          nextCursor: string | null;
        };
        if (kind === 'sessions')
          seenSessions.push(...body.sessions!.map((value) => value.session_id));
        else seenBodies.push(...body.batches!.map((value) => value.id));
        cursor = body.nextCursor;
      } while (cursor);
    }
    expect(seenSessions).toHaveLength(102);
    expect(new Set(seenSessions)).toEqual(new Set(sessions));
    expect(seenBodies).toHaveLength(102);
    expect(new Set(seenBodies).size).toBe(102);
    const filtered = await fetch(
      `${endpoint}/admin/sessions?session=${sessions[0]}&version=1.4.0&from=${stamp}&to=${stamp}&onlyFailures=1`,
      { headers: adminHeaders },
    );
    const body = (await filtered.json()) as { sessions: { session_id: string }[] };
    expect(body.sessions.map((value) => value.session_id)).toEqual([sessions[0]]);
    expect(
      (await fetch(`${endpoint}/admin/sessions?from=invalid`, { headers: adminHeaders })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${endpoint}/admin/batches?installation=${installation}&cursor=invalid`, {
          headers: adminHeaders,
        })
      ).status,
    ).toBe(400);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('recovers lost permits and failed atomic sealing without renewing the deadline, then rejects replay after cleanup and reinstallation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-expired-replay-'));
  let mf = runtime(join(directory, 'server'));
  let now = Date.now();
  const client = join(directory, 'client');
  let journal = new SessionJournal(client);
  let loseAck = true;
  let losePermit = true;
  const permits: unknown[] = [];
  const { handle } = (await import(
    `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`
  )) as { handle: (request: Request, env: unknown, now: number) => Promise<Response> };
  const environment = async () => ({
    ...bindings,
    DIAGNOSTICS_DB: await mf.getD1Database('DIAGNOSTICS_DB'),
    DIAGNOSTICS_BUCKET: await mf.getR2Bucket('DIAGNOSTICS_BUCKET'),
    ENROLL_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    UPLOAD_LIMITER: { limit: () => Promise.resolve({ success: true }) },
  });
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cf-connecting-ip', '127.0.0.1');
    const response = await handle(
      new Request(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        { ...init, headers },
      ),
      await environment(),
      now,
    );
    if (
      (input instanceof Request ? input.url : input instanceof URL ? input.href : input).includes(
        '/permits/',
      ) &&
      response.ok
    ) {
      permits.push((await response.clone().json()) as unknown);
      if (losePermit) {
        losePermit = false;
        await response.arrayBuffer();
        throw new Error('synthetic permit response lost after D1 commit');
      }
    }
    if (init?.method === 'PUT' && response.ok && loseAck) {
      loseAck = false;
      await response.arrayBuffer();
      throw new Error('synthetic receipt lost after durable acceptance');
    }
    return response;
  };
  const options = { endpoint: 'https://local.invalid', fetch: fetcher, now: () => now };
  let delivery = await new DiagnosticDelivery(client, journal, options).initialize(false);
  try {
    await migrate(await mf.getD1Database('DIAGNOSTICS_DB'));
    await delivery.consent(true);
    journal.record('workspace_exit_failure', {
      phase: 'restore_window',
      error: new Error('preserved original failure'),
    });
    await journal.flush();
    await delivery.tick();
    expect(delivery.status()).toMatchObject({ acknowledged: 0, queuedBatches: 1, failures: 1 });
    const readState = async () =>
      JSON.parse(await readFile(join(client, 'diagnostic-outbox/state.json'), 'utf8')) as {
        credentials: { installationId: string; enrollmentSecret: string; token: string };
        queue: { id: string; sealed: boolean; serverExpired?: boolean }[];
      };
    const unsealed = await readState();
    expect(unsealed.queue[0]!.sealed).not.toBe(true);
    const originalGzip = await readFile(
      join(client, `diagnostic-outbox/${unsealed.queue[0]!.id}.gz`),
    );
    expect(
      await (
        await mf.getD1Database('DIAGNOSTICS_DB')
      )
        .prepare('SELECT COUNT(*) AS count FROM batches')
        .first(),
    ).toMatchObject({ count: 0 });
    await delivery.close();
    await journal.close();
    await mf.dispose();
    mf = runtime(join(directory, 'server'));
    now += 86400_000;
    journal = new SessionJournal(client);
    delivery = await new DiagnosticDelivery(client, journal, options).initialize(false);
    const originalRename = filesystem.rename;
    let failCommit = true;
    const renameSpy = vi.spyOn(filesystem, 'rename').mockImplementation(async (...args) => {
      if (failCommit && args[1] === join(client, 'diagnostic-outbox/state.json')) {
        const pending = JSON.parse(await readFile(args[0], 'utf8')) as {
          queue: { sealed?: boolean }[];
        };
        if (pending.queue.some((item) => item.sealed)) {
          failCommit = false;
          throw Object.assign(new Error('synthetic sealed manifest EIO'), { code: 'EIO' });
        }
      }
      await originalRename(...args);
    });
    await delivery.tick();
    renameSpy.mockRestore();
    expect(failCommit).toBe(false);
    expect((await readState()).queue[0]!.sealed).not.toBe(true);
    expect(await readFile(join(client, `diagnostic-outbox/${unsealed.queue[0]!.id}.gz`))).toEqual(
      originalGzip,
    );
    expect(
      await (
        await mf.getD1Database('DIAGNOSTICS_DB')
      )
        .prepare('SELECT COUNT(*) AS count FROM batches')
        .first(),
    ).toMatchObject({ count: 0 });
    expect(permits).toHaveLength(2);
    expect(permits[1]).toEqual(permits[0]);
    await delivery.close();
    await journal.close();
    await mf.dispose();
    mf = runtime(join(directory, 'server'));
    now += 86400_000;
    journal = new SessionJournal(client);
    delivery = await new DiagnosticDelivery(client, journal, options).initialize(false);
    await delivery.tick();
    expect(permits).toHaveLength(3);
    expect(permits[2]).toEqual(permits[0]);
    const before = await readState();
    expect(before.queue[0]!.sealed).toBe(true);
    expect(
      await (
        await mf.getD1Database('DIAGNOSTICS_DB')
      )
        .prepare('SELECT quota_permits FROM installations WHERE id=?')
        .bind(before.credentials.installationId)
        .first(),
    ).toMatchObject({ quota_permits: 0 });
    const id = before.queue[0]!.id;
    const packet = await readFile(join(client, `diagnostic-outbox/${id}.gz`));
    const payload = readDiagnosticGzipPermit(packet)!.permit.payloadSha256;
    const renewPermit = (token: string) =>
      fetcher(`https://local.invalid/v1/diagnostics/permits/${payload}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    expect(JSON.stringify(await decodeDiagnosticBatch(packet))).toContain(
      'preserved original failure',
    );
    await delivery.close();
    await journal.close();
    await mf.dispose();
    mf = runtime(join(directory, 'server'));
    now += 8 * 86400_000;
    expect(
      (
        await handle(
          new Request('https://local.invalid/admin/cleanup', {
            method: 'POST',
            headers: adminHeaders,
          }),
          await environment(),
          now,
        )
      ).status,
    ).toBe(200);
    const db = await mf.getD1Database('DIAGNOSTICS_DB');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM batches').first()).toMatchObject({
      count: 0,
    });
    expect((await (await mf.getR2Bucket('DIAGNOSTICS_BUCKET')).list()).objects).toHaveLength(0);
    journal = new SessionJournal(client);
    delivery = await new DiagnosticDelivery(client, journal, options).initialize(false);
    await delivery.tick();
    expect(delivery.status()).toMatchObject({
      acknowledged: 0,
      error: 'server_retention_expired_local_copy_retained',
    });
    const after = await readState();
    expect(after.queue.find((batch) => batch.id === id)).toMatchObject({
      sealed: true,
      serverExpired: true,
    });
    expect(await readFile(join(client, `diagnostic-outbox/${id}.gz`))).toEqual(packet);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM batches').first()).toMatchObject({
      count: 0,
    });
    expect(await db.prepare('SELECT batches FROM sessions').first()).toMatchObject({ batches: 1 });
    expect((await renewPermit(before.credentials.token)).status).toBe(410);
    // Clearing the short-lived locators and even retiring/recreating an installation
    // cannot reset the first permit for the same original gzip SHA.
    now += 100 * 86400_000;
    expect(
      (
        await handle(
          new Request('https://local.invalid/admin/cleanup', {
            method: 'POST',
            headers: adminHeaders,
          }),
          await environment(),
          now,
        )
      ).status,
    ).toBe(200);
    for (const installationId of [before.credentials.installationId, randomUUID()]) {
      const registered = await fetcher('https://local.invalid/v1/diagnostics/enroll', {
        method: 'POST',
        body: JSON.stringify({
          consent: 'technical-diagnostics-v2',
          enrollmentId: installationId,
          enrollmentSecret: before.credentials.enrollmentSecret,
        }),
      });
      expect(registered.status).toBe(200);
      const identity = (await registered.json()) as { token: string };
      expect((await renewPermit(identity.token)).status).toBe(409);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM upload_permits').first()).toMatchObject({
      count: 1,
    });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM batches').first()).toMatchObject({
      count: 0,
    });

    expect((await (await mf.getR2Bucket('DIAGNOSTICS_BUCKET')).list()).objects).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    await delivery.close();
    await journal.close();
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('hides revoked evidence immediately even when SQLite refuses physical session deletion, then completes cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-revoke-failure-'));
  const mf = runtime(directory);
  try {
    const db = await mf.getD1Database('DIAGNOSTICS_DB');
    await migrate(db);
    const bucket = await mf.getR2Bucket('DIAGNOSTICS_BUCKET');
    const { handle } = (await import(
      `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`
    )) as { handle: (request: Request, env: unknown, now?: number) => Promise<Response> };
    const env = {
      ...bindings,
      DIAGNOSTICS_DB: db,
      DIAGNOSTICS_BUCKET: bucket,
      ENROLL_LIMITER: { limit: () => Promise.resolve({ success: true }) },
      UPLOAD_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    };
    const call = (path: string, init: RequestInit = {}) =>
      handle(
        new Request(`https://local.invalid${path}`, {
          ...init,
          headers: { 'cf-connecting-ip': '127.0.0.1', ...init.headers },
        }),
        env,
      );
    const installation = randomUUID();
    const identity = (await (
      await call('/v1/diagnostics/enroll', {
        method: 'POST',
        body: JSON.stringify({
          consent: 'technical-diagnostics-v2',
          enrollmentId: installation,
          enrollmentSecret: 'a'.repeat(64),
        }),
      })
    ).json()) as { token: string };
    const now = Date.now();
    const id = 'b'.repeat(64);
    const key = `v1/${installation}/${id}.gz`;
    await db
      .prepare(
        'INSERT INTO sessions(installation_id,session_id,first_received_at,last_received_at,events,failures,batches,bytes,expires_at) VALUES(?,?,?, ?,1,1,1,128,?)',
      )
      .bind(installation, randomUUID(), now, now, now + 90 * 86400_000)
      .run();
    await db
      .prepare(
        "INSERT INTO batches(installation_id,id,object_key,owner,state,writers,bytes,received_at,expires_at,metadata) VALUES(?,?,?,?,'ready',0,128,?,?,'{}')",
      )
      .bind(installation, id, key, randomUUID(), now, now + 7 * 86400_000)
      .run();
    await bucket.put(key, gzipSync('public synthetic evidence'));
    await db.exec(
      "CREATE TRIGGER refuse_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'synthetic SQLite delete failure'); END;",
    );
    expect(
      (
        await call('/v1/diagnostics/installation', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${identity.token}` },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await db
          .prepare('SELECT revoked_at FROM installations WHERE id=?')
          .bind(installation)
          .first<{ revoked_at: number }>()
      )?.revoked_at,
    ).toBeGreaterThan(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first()).toMatchObject({
      count: 1,
    });
    for (const kind of ['sessions', 'batches']) {
      const result = await call(`/admin/${kind}?installation=${installation}`, {
        headers: adminHeaders,
      });
      expect(await result.json()).toMatchObject({ [kind]: [] });
    }
    expect(
      (await call(`/admin/bodies/${installation}/${id}`, { headers: adminHeaders })).status,
    ).toBe(404);
    await db.exec('DROP TRIGGER refuse_session_delete;');
    expect((await call('/admin/cleanup', { method: 'POST', headers: adminHeaders })).status).toBe(
      200,
    );
    expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first()).toMatchObject({
      count: 0,
    });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM batches').first()).toMatchObject({
      count: 0,
    });
    expect((await bucket.list()).objects).toHaveLength(0);
    const afterRetention = now + 100 * 86400_000;
    expect(
      (
        await handle(
          new Request('https://local.invalid/admin/cleanup', {
            method: 'POST',
            headers: adminHeaders,
          }),
          env,
          afterRetention,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await db
          .prepare('SELECT revoked_at FROM installations WHERE id=?')
          .bind(installation)
          .first<{ revoked_at: number }>()
      )?.revoked_at,
    ).toBeGreaterThan(0);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('indexes single-source failures and their original UTC through real envelopes, restart and healthy subsequent batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cloud-envelopes-'));
  const mf = runtime(join(directory, 'server'), 100);
  const endpoint = (await mf.ready).origin;
  const client = join(directory, 'client');
  const realNow = Date.now();
  const sourceUtc = new Date(realNow - 3600_000).toISOString();
  const laterUtc = new Date(realNow - 1800_000).toISOString();
  const rootSource = () => ({
    id: randomUUID(),
    time: sourceUtc,
    sessionId: randomUUID(),
    hostSessionId: 'original-owned-host',
    queuedAfterSequence: 12,
    recordSequence: 1,
    monotonicMs: 50,
  });
  const browser = (operation = 'browser_error') => ({
    operation,
    phase: 'failure',
    time: sourceUtc,
    browserDocumentId: randomUUID(),
    evidence: {
      error: {
        name: 'Error',
        message: 'original browser failure',
        cause: { message: 'draw failed', code: 'EACCES' },
      },
    },
  });
  const browserPerformance = {
    page: '/program',
    reason: 'interval',
    windowMs: 30 * 60_000,
    visibility: 'visible',
    frames: { callbacks: 100, maxGapMs: 9999, over50ms: 1 },
    longTasks: { supported: true, count: 1, maxDurationMs: 5000 },
    channels: [],
    anomalyCount: 1,
    omittedAnomalySamples: 0,
    anomalies: [
      {
        time: sourceUtc,
        kind: 'radar_draw_not_advancing',
        drawnSequence: 41,
        receivedSequence: 77,
        ageMs: 4000,
      },
    ],
  };
  const cases: { stage: string; evidence: unknown; kind: string }[] = [
    { stage: 'browser_control', evidence: browser(), kind: 'browser' },
    {
      stage: 'native_host_records',
      evidence: {
        source: { name: 'desktop.ndjson', identity: 'public-file-id' },
        entries: [
          {
            sourceRecordId: randomUUID(),
            offset: 1024,
            bytes: 256,
            entry: {
              time: sourceUtc,
              startupSessionId: 'original-owned-host',
              stage: 'native_command',
              result: 'failure',
              detail: JSON.stringify({
                command: 'finish_workspace',
                outcome: 'Err(original native restore EACCES)',
                operationId: randomUUID(),
              }),
            },
          },
        ],
      },
      kind: 'native',
    },
    {
      stage: 'performance_anomaly_begin',
      evidence: {
        id: randomUUID(),
        reason: 'telemetry_diagnostic',
        sourceRecord: rootSource(),
        correlation: { error: { name: 'Error', message: 'original pre-restart telemetry cause' } },
      },
      kind: 'telemetry',
    },
    {
      stage: 'performance_anomaly_trigger',
      evidence: {
        id: randomUUID(),
        reason: 'browser_anomaly',
        sourceRecord: { ...rootSource(), time: laterUtc },
        correlation: {
          operation: 'browser_unhandled_rejection',
          observedAt: sourceUtc,
          originalEvidence: browser('browser_unhandled_rejection').evidence,
        },
      },
      kind: 'browser',
    },
    {
      stage: 'update_stage',
      evidence: {
        event: 'update',
        time: realNow - 3600_000,
        stage: 'result_load',
        code: 'update_initialization_failed',
        diagnostic: {
          operationId: randomUUID(),
          result: 'failure',
          error: { name: 'Error', message: 'original update recovery cause' },
        },
      },
      kind: 'update',
    },
    {
      stage: 'business_evidence',
      evidence: {
        stage: 'business_runtime',
        recordedAt: sourceUtc,
        startupSessionId: randomUUID(),
        evidence: {
          status: 'rejected',
          identity: 'mismatch',
          binding: 'needs_operator',
          blockers: ['roster_conflict'],
          reason: 'roster_conflict',
        },
      },
      kind: 'business',
    },
    {
      stage: 'browser_control',
      evidence: {
        operation: 'browser_performance',
        phase: 'window',
        time: laterUtc,
        browserDocumentId: randomUUID(),
        evidence: browserPerformance,
      },
      kind: 'performance',
    },
    {
      stage: 'performance_anomaly_trigger',
      evidence: {
        id: randomUUID(),
        reason: 'browser_anomaly',
        sourceRecord: { ...rootSource(), time: laterUtc },
        correlation: {
          operation: 'browser_performance',
          observedAt: laterUtc,
          originalEvidence: browserPerformance,
        },
      },
      kind: 'performance',
    },
  ];
  const fetcher: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cf-connecting-ip', '127.0.0.1');
    return fetch(input, { ...init, headers });
  };
  let journal: SessionJournal | undefined;
  let delivery: DiagnosticDelivery | undefined;
  const drain = async () => {
    for (let poll = 0; delivery!.status().queuedBatches && poll < 10; poll++)
      await delivery!.tick();
    expect(delivery!.status().queuedBatches).toBe(0);
  };
  try {
    await migrate(await mf.getD1Database('DIAGNOSTICS_DB'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(realNow - 2 * 3600_000);
    journal = new SessionJournal(client, { appVersion: '1.4.0' });
    delivery = await new DiagnosticDelivery(client, journal, {
      endpoint,
      allowTestEndpoint: true,
      fetch: fetcher,
    }).initialize(false);
    await delivery.consent(true);
    await journal.flush();
    await delivery.tick();
    await drain();
    await delivery.close();
    await journal.close();
    vi.setSystemTime(realNow);
    for (const fixture of cases) {
      journal = new SessionJournal(client, { appVersion: '1.4.0' });
      journal.record(fixture.stage, fixture.evidence);
      await journal.flush();
      delivery = await new DiagnosticDelivery(client, journal, {
        endpoint,
        allowTestEndpoint: true,
        fetch: fetcher,
      }).initialize(false);
      await delivery.tick();
      await drain();
      // A separate successful batch must not reset the earlier failure or source bounds.
      journal.record('operation_result', { httpStatus: 200, result: { confirmed: true } });
      await journal.flush();
      await delivery.tick();
      await drain();
      const response = await fetch(
        `${endpoint}/admin/sessions?session=${journal.sessionId}&onlyFailures=1&from=${sourceUtc}&to=${sourceUtc}`,
        { headers: adminHeaders },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        sessions: {
          failures: number;
          failure_kinds: string;
          source_from: string;
          batches: number;
          source_time_unknown: number;
        }[];
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        failures: 1,
        source_from: sourceUtc,
        source_time_unknown: 0,
      });
      expect(JSON.parse(result.sessions[0]!.failure_kinds)).toContain(fixture.kind);
      expect(result.sessions[0]!.batches).toBeGreaterThan(1);
      await delivery.close();
      await journal.close();
    }
    journal = new SessionJournal(client, { appVersion: '1.4.0' });
    delivery = await new DiagnosticDelivery(client, journal, {
      endpoint,
      allowTestEndpoint: true,
      fetch: fetcher,
    }).initialize(false);
    const currentUtc = new Date().toISOString();
    journal.record('browser_control', {
      operation: 'task',
      phase: 'terminal',
      time: currentUtc,
      evidence: { evidence: { result: 'cancelled' } },
    });
    journal.record('performance_anomaly_begin', {
      id: randomUUID(),
      reason: 'input_silence',
      sourceRecord: { ...rootSource(), time: currentUtc },
      correlation: { ageMs: 10000 },
    });
    journal.record('browser_control', {
      ...browser(),
      time: new Date(realNow - 3 * 3600_000).toISOString(),
      evidence: { error: { message: 'must_not_upload_pre_consent_browser' } },
    });
    journal.record('performance_anomaly_trigger', {
      id: randomUUID(),
      reason: 'browser_anomaly',
      sourceRecord: { ...rootSource(), time: currentUtc },
      correlation: {
        operation: 'browser_error',
        observedAt: new Date(realNow - 3 * 3600_000).toISOString(),
        originalEvidence: { error: { message: 'must_not_upload_pre_consent_window_cause' } },
      },
    });
    await journal.flush();
    await delivery.tick();
    await drain();
    const healthy = (await (
      await fetch(`${endpoint}/admin/sessions?session=${journal.sessionId}&onlyFailures=1`, {
        headers: adminHeaders,
      })
    ).json()) as { sessions: unknown[] };
    expect(healthy.sessions).toHaveLength(0);
    const bucket = await mf.getR2Bucket('DIAGNOSTICS_BUCKET');
    for (const item of (await bucket.list()).objects) {
      const body = await (await bucket.get(item.key))!.arrayBuffer();
      expect(JSON.stringify(await decodeDiagnosticBatch(Buffer.from(body)))).not.toContain(
        'must_not_upload_pre_consent',
      );
    }
    expect(await readFile(join(client, 'session.ndjson'), 'utf8')).toContain(
      'must_not_upload_pre_consent_browser',
    );
  } finally {
    vi.useRealTimers();
    await delivery?.close();
    await journal?.close();
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
