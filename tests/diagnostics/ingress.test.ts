import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SupportExports } from '../../apps/companion/src/support/export-job.js';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import { DiagnosticDelivery } from '../../apps/companion/src/support/delivery.js';
import { migrate, runtime } from './fixture.js';

test('domestic ingress preserves per-client limits without trusting caller-supplied addresses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-ingress-limit-'));
  const receiver = runtime(root, 1);
  try {
    const request = async (
      peer: string,
      client?: string,
      host = 'diagnostics-origin.starfie1d.top',
    ) => {
      const headers: Record<string, string> = { 'cf-connecting-ip': peer };
      if (client !== undefined) headers['x-mizar-client-ip'] = client;
      return (
        await receiver.dispatchFetch(`https://${host}/v1/diagnostics/installation`, { headers })
      ).status;
    };
    // Authentication remains required. Independent clients have independent limits.
    assert.equal(await request('47.103.131.158', '192.0.2.1'), 401);
    assert.equal(await request('47.103.131.158', '192.0.2.2'), 401);
    assert.equal(await request('47.103.131.158', '192.0.2.1'), 429);
    // Changing a forwarded header from an untrusted peer cannot evade its limit.
    assert.equal(await request('198.51.100.10', '192.0.2.3'), 401);
    assert.equal(await request('198.51.100.10', '192.0.2.4'), 429);
    for (const invalid of [undefined, '999.1.1.1', '192.0.2.1,192.0.2.2', ''])
      assert.equal(await request('47.103.131.158', invalid), 403);
    assert.equal(
      await request('47.103.131.158', undefined, 'mizar-diagnostics.duxinyu475.workers.dev'),
      401,
    );
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unacknowledged old-endpoint batch resumes unchanged through ingress and can be withdrawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-ingress-migration-'));
  const receiver = runtime(join(root, 'receiver'));
  const db = await receiver.getD1Database('DIAGNOSTICS_DB');
  await migrate(db);
  const client = join(root, 'client');
  const journal = new SessionJournal(client);
  const manifest = async () =>
    JSON.parse(await readFile(join(client, 'diagnostic-outbox/state.json'), 'utf8'));
  const uploads: { id: string; bytes: Uint8Array; host: string }[] = [];
  let dropAck = true;
  let now = Date.now();
  const options = {
    now: () => now,
    participants: () => [],
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.hostname === 'diagnostics.starfie1d.top') {
        // The proxy overwrites, rather than appends to, the socket address.
        headers.set('cf-connecting-ip', '47.103.131.158');
        headers.set('x-mizar-client-ip', '192.0.2.40');
        url.hostname = 'diagnostics-origin.starfie1d.top';
      } else headers.set('cf-connecting-ip', '192.0.2.40');
      if (init?.method === 'PUT')
        uploads.push({
          id: headers.get('x-content-sha256')!,
          bytes: new Uint8Array(init.body as Uint8Array),
          host: url.hostname,
        });
      const response = await receiver.dispatchFetch(url, { ...init, headers });
      if (init?.method === 'PUT' && dropAck && response.ok) {
        dropAck = false;
        throw new Error('synthetic lost ACK');
      }
      return response;
    },
  };
  let delivery = await new DiagnosticDelivery(client, journal, {
    ...options,
    endpoint: 'https://mizar-diagnostics.duxinyu475.workers.dev',
  }).initialize(false);
  try {
    await delivery.consent(true);
    await journal.recordCommitted('operation_result', { result: 'success' });
    await journal.recordCommitted('preparation_task', {
      step: 'game',
      attempt: 2,
      details: {
        code: 'launch_unconfirmed',
        cause: 'CreateProcess failed: 文件不存在; token=ingress-test-secret',
      },
    });
    await journal.recordCommitted('gsi_status', {
      observations: 2,
      result: {
        detected: true,
        installed: false,
        readFailed: false,
        conflict: true,
        issues: [{ code: 'endpoint-conflict', message: 'private status detail' }],
        lastOperation: { code: 'endpoint-conflict', stage: 'checking' },
        cfgPath: 'private-path',
      },
    });
    await journal.recordCommitted('cs2_host_status', {
      result: {
        found: true,
        managed: false,
        layoutAligned: false,
        layoutPending: true,
        generation: 3,
        visible: true,
        geometry: { secret: 'private-geometry' },
        message: 'private-window',
      },
    });
    await journal.recordCommitted('camera_host_session', {
      action: 'invalidate',
      lease: { token: 'private-lease' },
      nested: { kind: 'program_all_chat', evidence: { text: 'private-chat-marker' } },
    });
    await journal.recordCommitted('observer_assist_state', {
      blocked: 'source-stale',
      pending: 3,
      anchors: 0,
      source: { connected: true, fresh: false, receiveAgeMs: 5000, endpoint: 'private-endpoint' },
      lastReset: { reason: 'map-changed', atMonotonicMs: 42 },
    });
    await delivery.tick();
    assert.equal(uploads.length, 1);
    assert.equal(delivery.status().acknowledged, 0);
    const before = await manifest();
    const stored = await db
      .prepare('SELECT COUNT(*) AS count FROM batches WHERE state=?')
      .bind('ready')
      .first();
    assert.equal(stored?.count, 1, 'the first upload was actually persisted despite its lost ACK');
    await journal.recordCommitted('during_transport_backoff', { result: 'retained locally' });
    await delivery.tick();
    assert.deepEqual((await manifest()).queue, before.queue);
    assert.equal(uploads.length, 1);
    await delivery.close();
    now = Math.max(now, delivery.status().nextAttemptAt) + 1000;
    delivery = await new DiagnosticDelivery(client, journal, {
      ...options,
      endpoint: 'https://diagnostics.starfie1d.top',
    }).initialize(false);
    await delivery.tick(false);
    const replay = uploads.find(
      (upload) =>
        upload.host === 'diagnostics-origin.starfie1d.top' && upload.id === uploads[0]!.id,
    );
    assert(replay);
    assert.deepEqual(replay.bytes, uploads[0]!.bytes);
    assert(delivery.status().acknowledged >= 1);
    await delivery.tick(false);
    assert(
      uploads.some(({ bytes }) =>
        JSON.parse(gunzipSync(bytes).toString()).events.some(
          ({ kind }: { kind: string }) => kind === 'during_transport_backoff',
        ),
      ),
    );
    assert(before.credentials.installationId);
    assert.equal((await manifest()).credentials.installationId, before.credentials.installationId);
    assert.equal(
      (
        await db
          .prepare('SELECT COUNT(*) AS count FROM batches WHERE id=?')
          .bind(uploads[0]!.id)
          .first()
      )?.count,
      1,
    );
    const row = await db
      .prepare('SELECT object_key FROM batches WHERE id=?')
      .bind(uploads[0]!.id)
      .first<{ object_key: string }>();
    assert(row);
    const object = await (await receiver.getR2Bucket('DIAGNOSTICS_BUCKET')).get(row.object_key);
    assert(object);
    assert.deepEqual(new Uint8Array(await object.arrayBuffer()), uploads[0]!.bytes);
    const uploaded = JSON.parse(gunzipSync(uploads[0]!.bytes).toString('utf8'));
    const evidence = (kind: string) =>
      uploaded.events.find((event: { kind: string }) => event.kind === kind)?.evidence;
    assert.deepEqual(evidence('gsi_status').result, {
      detected: true,
      installed: false,
      conflict: true,
      readFailed: false,
      issues: [{ code: 'endpoint-conflict', message: 'private status detail' }],
      lastOperation: { code: 'endpoint-conflict', stage: 'checking' },
      cfgPath: 'private-path',
    });
    assert.equal(evidence('cs2_host_status').result.found, true);
    assert.equal(evidence('cs2_host_status').result.layoutAligned, false);
    assert.equal(evidence('camera_host_session').action, 'invalidate');
    assert.deepEqual(evidence('preparation_task'), {
      step: 'game',
      attempt: 2,
      details: {
        code: 'launch_unconfirmed',
        cause: 'CreateProcess failed: 文件不存在; token=[redacted]',
      },
    });
    assert.deepEqual(evidence('observer_assist_state').source, {
      connected: true,
      fresh: false,
      receiveAgeMs: 5000,
      endpoint: 'private-endpoint',
    });
    assert.equal(evidence('observer_assist_state').lastReset.reason, 'map-changed');
    assert(!JSON.stringify(uploaded).includes('ingress-test-secret'));
    assert(!JSON.stringify(uploaded).includes('private-lease'));
    assert(!JSON.stringify(uploaded).includes('private-chat-marker'));
    await journal.flush();
    const exports = new SupportExports(client);
    const job = await exports.begin({}, {});
    try {
      const deadline = Date.now() + 15_000;
      while (!exports.status(job.exportId)?.settled && Date.now() < deadline) await delay(20);
      assert.equal(exports.status(job.exportId)?.phase, 'ready');
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../scripts/diagnostics/read-support-bundle.mjs', import.meta.url),
          ),
          join(exports.directory, job.exportId, 'part-1.zip'),
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const exported = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const event of uploaded.events) {
        const canonical = exported.find(
          (entry) => entry.eventId === event.eventId && !entry.projection,
        );
        assert(canonical, `Missing exported source: ${event.kind}`);
        assert.deepEqual(event.evidence, canonical.evidence, event.kind);
      }
    } finally {
      await exports.cancel(job.exportId);
    }
    await delivery.consent(false);
    await delivery.tick(false);
    assert.equal(delivery.status().deletionPending, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM batches').first())?.count, 0);
    assert.equal(
      (await (await receiver.getR2Bucket('DIAGNOSTICS_BUCKET')).list()).objects.length,
      0,
    );
  } finally {
    await delivery.close();
    await journal.close();
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
