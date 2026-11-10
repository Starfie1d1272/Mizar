import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticDelivery } from '../../apps/companion/src/support/delivery.js';
import { SessionJournal } from '../../apps/companion/src/support/session-journal.js';
import {
  diagnosticGzipCreatedAt,
  readDiagnosticGzipPermit,
  sealDiagnosticGzip,
} from '../../packages/protocol/src/diagnostics-upload.js';
import { meteredRuntime } from '../../scripts/diagnostics/capacity-runtime.mjs';
import { migrate } from './fixture.js';

const loader = createRequire(new URL('../../apps/companion/package.json', import.meta.url)).resolve(
  'tsx',
);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function rig(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-diagnostic-recovery-'));
  const mf = meteredRuntime(join(root, 'server'));
  const endpoint = (await mf.ready).origin;
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname));
  const db = await mf.getD1Database('DIAGNOSTICS_DB');
  await migrate(db);
  const clients: { journal: SessionJournal; delivery: DiagnosticDelivery }[] = [];
  let now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const requests: { path: string; method: string | undefined; status: number }[] = [];
  let deletionUnavailable = false;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', '192.0.2.8');
    return fetch(endpoint + path, { ...init, headers });
  };
  const clock = async (value = now) => {
    now = value;
    t.mock.timers.setTime(now);
    const response = await request('/__test/control', {
      method: 'POST',
      body: JSON.stringify({ now, accepting: true }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  };
  await clock();
  t.after(async () => {
    for (const { delivery, journal } of clients) {
      await delivery.close();
      await journal.close();
    }
    await mf.dispose();
    t.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  });
  const client = async (name: string) => {
    const directory = join(root, name);
    const journal = new SessionJournal(directory, { appVersion: '1.4.0' });
    const delivery = await new DiagnosticDelivery(directory, journal, {
      endpoint,
      allowTestEndpoint: true,
      now: () => now,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const response =
          deletionUnavailable && init?.method === 'DELETE'
            ? Response.json(
                { error: 'synthetic_delete_unavailable' },
                { status: 503, headers: { 'retry-after': '3600' } },
              )
            : await request(path, init);
        requests.push({ path, method: init?.method, status: response.status });
        return response;
      },
    }).initialize(false);
    clients.push({ journal, delivery });
    return {
      directory,
      journal,
      delivery,
      state: async () =>
        JSON.parse(await readFile(join(directory, 'diagnostic-outbox/state.json'), 'utf8')),
      record: async () => {
        journal.record('workspace_exit_begin', {
          synthetic: true,
          before: { workspace: 'active' },
        });
        await journal.flush();
      },
    };
  };
  return {
    root,
    endpoint,
    db,
    client,
    requests,
    clock,
    now: () => now,
    request,
    failDeletion: (fail: boolean) => {
      deletionUnavailable = fail;
    },
  };
}

test('sealed wire survives SIGKILL before manifest commit, rejects corruption, and recovers after a failed state commit', async (t) => {
  const r = await rig(t);
  const directory = join(r.root, 'crashed');
  const child = spawn(
    process.execPath,
    [
      '--import',
      loader,
      fileURLToPath(new URL('./seal-crash.mjs', import.meta.url)),
      r.endpoint,
      directory,
      String(r.now()),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (value) => {
    output += value;
  });
  child.stderr.on('data', (value) => {
    output += value;
  });
  const exit = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  assert.equal(exit.signal, 'SIGKILL', output);
  const outbox = join(directory, 'diagnostic-outbox');
  const before = JSON.parse(await readFile(join(outbox, 'state.json'), 'utf8'));
  const rawBatch = before.queue[0];
  assert(!rawBatch.sealed);
  const sealedName = (await readdir(outbox)).find(
    (name) => name.endsWith('.gz') && name !== rawBatch.id + '.gz',
  )!;
  assert(sealedName);
  const original = await readFile(join(outbox, sealedName));
  const seal = readDiagnosticGzipPermit(original)!;
  assert.equal(seal.permit.installationId, before.credentials.installationId);
  assert.equal(seal.permit.payloadSha256, rawBatch.id);
  assert.equal(hash(original), sealedName.slice(0, -3));
  assert.deepEqual(Buffer.from(seal.payload), await readFile(join(outbox, rawBatch.id + '.gz')));

  await cp(directory, join(r.root, 'corrupt'), { recursive: true });
  const corruptPath = join(r.root, 'corrupt/diagnostic-outbox', sealedName);
  const corruptBytes = Buffer.from(original);
  corruptBytes[corruptBytes.length - 1]! ^= 1;
  await writeFile(corruptPath, corruptBytes);
  const corrupt = await r.client('corrupt');
  await corrupt.delivery.tick(false);
  assert.equal(corrupt.delivery.status().error, 'sealed_batch_conflict_local_copy_retained');
  assert.equal(corrupt.delivery.status().blockedBatches, 1);
  assert.equal((await corrupt.state()).queue[0].unavailableReason, 'sealed_batch_conflict');
  assert.deepEqual(
    await readFile(join(corrupt.directory, 'diagnostic-outbox', rawBatch.id + '.gz')),
    Buffer.from(seal.payload),
  );
  assert.equal(corrupt.delivery.status().acknowledged, 0);
  assert.deepEqual(await readFile(corruptPath), corruptBytes);
  assert.equal((await corrupt.state()).queue[0].id, rawBatch.id);
  assert(!r.requests.some((request) => request.method === 'PUT'));

  const recovered = await r.client('crashed');
  // Fault only the local state commit after verifying the actual orphan bytes.
  const internal = recovered.delivery as unknown as {
    state: { queue: { sealed?: boolean }[] };
    save: () => Promise<void>;
  };
  const save = internal.save.bind(recovered.delivery);
  let failCommit = true;
  internal.save = async () => {
    if (failCommit && internal.state.queue[0]?.sealed)
      throw new Error('synthetic_manifest_commit_failed');
    await save();
  };
  await recovered.delivery.tick(false);
  assert.equal(recovered.delivery.status().error, 'synthetic_manifest_commit_failed');
  assert.equal((await recovered.state()).queue[0].id, rawBatch.id);
  assert.deepEqual(await readFile(join(outbox, sealedName)), original);
  failCommit = false;
  await r.clock(Math.ceil(recovered.delivery.status().nextAttemptAt));
  await recovered.delivery.tick(false);
  assert.equal(recovered.delivery.status().acknowledged, 1);
  const rows = await r.db
    .prepare('SELECT id,state,writers FROM batches WHERE installation_id=?')
    .bind(before.credentials.installationId)
    .all();
  assert.deepEqual(rows.results, [{ id: hash(original), state: 'ready', writers: 0 }]);
  const session = await r.db
    .prepare('SELECT sum(batches) count FROM sessions WHERE installation_id=?')
    .bind(before.credentials.installationId)
    .first();
  assert.equal(session?.count, 1);
  await corrupt.record();
  await corrupt.delivery.tick();
  assert.equal(
    corrupt.delivery.status().acknowledged,
    1,
    'a conflicting old sealed file cannot block later batches',
  );
  assert.equal(corrupt.delivery.status().blockedBatches, 1);
  assert.deepEqual(await readFile(corruptPath), corruptBytes);
});

test('a SIGKILL during sealed write resumes only the proven prefix, including another failed suffix write', async (t) => {
  const r = await rig(t);
  const directory = join(r.root, 'partial');
  const child = spawn(
    process.execPath,
    [
      '--import',
      loader,
      fileURLToPath(new URL('./seal-crash.mjs', import.meta.url)),
      r.endpoint,
      directory,
      String(r.now()),
      'partial',
    ],
    { stdio: 'ignore' },
  );
  const signal = await new Promise<string | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (_code, signal) => resolve(signal));
  });
  assert.equal(signal, 'SIGKILL');
  const outbox = join(directory, 'diagnostic-outbox');
  const before = JSON.parse(await readFile(join(outbox, 'state.json'), 'utf8'));
  const rawBatch = before.queue[0];
  const raw = await readFile(join(outbox, rawBatch.id + '.gz'));
  const response = await r.request('/v1/diagnostics/permits/' + rawBatch.id, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + before.credentials.token,
      'x-diagnostics-created-at': String(diagnosticGzipCreatedAt(raw)),
    },
  });
  assert.equal(response.status, 200);
  const expected = Buffer.from(sealDiagnosticGzip(raw, await response.json()));
  const path = join(outbox, hash(expected) + '.gz');
  const partial = await readFile(path);
  assert(partial.length < expected.length);
  assert.deepEqual(partial, expected.subarray(0, partial.length));
  await cp(directory, join(r.root, 'inplace-conflict'), { recursive: true });
  const c = await r.client('partial');
  const probe = await open(join(r.root, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  await unlink(join(r.root, 'probe'));
  const writeHandle = prototype.writeFile;
  let failed = false;
  prototype.writeFile = async function (bytes: unknown, ...args: unknown[]) {
    if (!failed && Buffer.isBuffer(bytes) && bytes.equals(expected.subarray(partial.length))) {
      failed = true;
      await writeHandle.call(this, bytes.subarray(0, Math.floor(bytes.length / 2)), ...args);
      throw new Error('synthetic_suffix_write_failed');
    }
    return writeHandle.call(this, bytes, ...args);
  };
  try {
    await c.delivery.tick(false);
  } finally {
    prototype.writeFile = writeHandle;
  }
  assert(failed);
  assert.equal(c.delivery.status().error, 'synthetic_suffix_write_failed');
  const repairedPrefix = await readFile(path);
  assert(repairedPrefix.length > partial.length);
  assert.deepEqual(repairedPrefix, expected.subarray(0, repairedPrefix.length));
  assert.equal((await c.state()).queue[0].id, rawBatch.id);
  await r.clock(Math.ceil(c.delivery.status().nextAttemptAt));
  await c.delivery.tick(false);
  assert.equal(c.delivery.status().acknowledged, 1);
  assert.equal(
    (
      await r.db
        .prepare('SELECT id FROM batches WHERE installation_id=?')
        .bind(before.credentials.installationId)
        .first()
    )?.id,
    hash(expected),
  );
  const conflict = await r.client('inplace-conflict');
  const conflictPath = join(conflict.directory, 'diagnostic-outbox', hash(expected) + '.gz');
  const target = await open(conflictPath, 'r');
  const identity = await target.stat();
  await target.close();
  const changed = Buffer.from(expected);
  changed[changed.length - 1]! ^= 1;
  const sync = prototype.sync;
  let tampered = false;
  prototype.sync = async function () {
    const current = await this.stat();
    if (!tampered && current.ino === identity.ino && current.dev === identity.dev) {
      tampered = true;
      // A separate writer changes the same inode without changing its size.
      await writeFile(conflictPath, changed);
    }
    return sync.call(this);
  };
  try {
    await conflict.delivery.tick(false);
  } finally {
    prototype.sync = sync;
  }
  assert(tampered);
  assert.equal(conflict.delivery.status().acknowledged, 0);
  assert.equal(conflict.delivery.status().blockedBatches, 1);
  assert.equal(conflict.delivery.status().error, 'sealed_batch_conflict_local_copy_retained');
  assert.deepEqual(await readFile(conflictPath), changed);
  assert.deepEqual(
    await readFile(join(conflict.directory, 'diagnostic-outbox', rawBatch.id + '.gz')),
    raw,
  );
});

test('old deletion keeps its own pending receipt, retry budget and pause-independent schedule without blocking a new consent', async (t) => {
  const r = await rig(t);
  let c = await r.client('client');
  await c.delivery.consent(true);
  await c.record();
  await c.delivery.tick();
  const before = await c.state();
  assert.equal(c.delivery.status().acknowledged, 1);
  const oldId = before.credentials.installationId;
  // Production interruption boundary: ready committed but writer finally did
  // not run. The Worker must retain this unknown writer until it actually closes.
  await r.db.prepare('UPDATE batches SET writers=1 WHERE installation_id=?').bind(oldId).run();
  await c.delivery.consent(false);
  await c.delivery.tick(false);
  let pending = (await c.state()).withdrawals[0];
  assert.equal(c.delivery.status().deletionPending, 1);
  assert(pending.nextAttemptAt > r.now());
  assert.equal(c.delivery.status().nextAttemptAt, 0);
  assert.equal(r.requests.at(-1)?.status, 202);

  // Restore an actual pre-fix manifest shape: deletion failures occupied the
  // global transport slot and withdrawals had no independent scheduling fields.
  await c.delivery.close();
  await c.journal.close();
  const legacy = await c.state();
  legacy.transportFailure = { phase: 'withdrawal', status: 503, reason: 'unconfirmed' };
  legacy.nextAttemptAt = r.now() + 60_000;
  legacy.serverRetryAt = legacy.nextAttemptAt;
  legacy.consecutiveFailures = 3;
  delete legacy.withdrawals[0].nextAttemptAt;
  delete legacy.withdrawals[0].serverRetryAt;
  delete legacy.withdrawals[0].consecutiveFailures;
  await writeFile(join(c.directory, 'diagnostic-outbox/state.json'), JSON.stringify(legacy));
  c = await r.client('client');
  const migrated = await c.state();
  pending = migrated.withdrawals[0];
  assert.equal(pending.nextAttemptAt, legacy.nextAttemptAt);
  assert.equal(pending.consecutiveFailures, 3);
  assert.equal(migrated.transportFailure, null);
  assert.equal(migrated.nextAttemptAt, 0);
  assert.equal(migrated.serverRetryAt, 0);
  assert.equal(c.delivery.status().error, null);
  assert.equal(c.delivery.status().deletionPending, 1);

  await c.delivery.pause(true);
  await c.delivery.consent(true);
  await c.record();
  await c.delivery.tick();
  assert.equal(c.delivery.status().acknowledged, 1, 'new consent still honors pause');
  const newId = (await c.state()).credentials.installationId;
  assert.notEqual(newId, oldId);
  r.failDeletion(true);
  await r.clock(Math.max(pending.nextAttemptAt, r.now() + 60_000));
  await c.delivery.tick(false);
  const limited = await c.state();
  assert.equal(limited.withdrawals[0].serverRetryAt, r.now() + 3600_000);
  assert.equal(limited.serverRetryAt, 0, 'old deletion Retry-After does not block the new upload');
  await c.delivery.pause(false);
  await r.clock(Math.ceil(c.delivery.status().nextAttemptAt));
  await c.delivery.tick(false);
  assert.equal(c.delivery.status().acknowledged, 2);
  assert.equal(c.delivery.status().deletionPending, 1);
  assert.equal(c.delivery.status().transportFailure, null);

  const deletedBeforeRestart = r.requests.filter((value) => value.method === 'DELETE').length;
  await c.delivery.close();
  await c.journal.close();
  c = await r.client('client');
  await c.record();
  await c.delivery.tick();
  assert.equal(c.delivery.status().acknowledged, 3);
  assert.equal(
    r.requests.filter((value) => value.method === 'DELETE').length,
    deletedBeforeRestart,
  );
  assert.equal(
    (await c.state()).withdrawals[0].nextAttemptAt,
    limited.withdrawals[0].nextAttemptAt,
  );
  const old = await r.db
    .prepare('SELECT revoked_at FROM installations WHERE id=?')
    .bind(oldId)
    .first();
  assert(old?.revoked_at !== null);
  const active = await r.db
    .prepare('SELECT revoked_at FROM installations WHERE id=?')
    .bind(newId)
    .first();
  assert.equal(active?.revoked_at, null);
  assert.equal(
    (await r.db.prepare('SELECT writers FROM batches WHERE installation_id=?').bind(oldId).first())
      ?.writers,
    1,
  );

  // Only an actual complete receipt removes the old deletion intent.
  r.failDeletion(false);
  await r.db.prepare('UPDATE batches SET writers=0 WHERE installation_id=?').bind(oldId).run();
  await r.clock(limited.withdrawals[0].nextAttemptAt);
  await c.delivery.tick(false);
  assert.equal(c.delivery.status().deletionPending, 0);
  assert.equal(
    (
      await r.db
        .prepare('SELECT count(*) count FROM batches WHERE installation_id=?')
        .bind(oldId)
        .first()
    )?.count,
    0,
  );
  assert(
    Number(
      (
        await r.db
          .prepare('SELECT sum(batches) count FROM sessions WHERE installation_id=?')
          .bind(newId)
          .first()
      )?.count,
    ) >= 2,
    'completing the old withdrawal preserves every accepted new-identity batch',
  );
  for (const phase of ['enrollment', 'permit', 'upload']) {
    const name = 'current-' + phase;
    await cp(c.directory, join(r.root, name), { recursive: true });
    const current = await c.state();
    current.transportFailure = { phase, status: 503, reason: 'unconfirmed' };
    current.nextAttemptAt = r.now() + 3600_000;
    current.serverRetryAt = current.nextAttemptAt;
    current.consecutiveFailures = 4;
    await writeFile(join(r.root, name, 'diagnostic-outbox/state.json'), JSON.stringify(current));
    const restored = await r.client(name);
    assert.deepEqual(restored.delivery.status().transportFailure, current.transportFailure);
    assert.equal(restored.delivery.status().nextAttemptAt, current.nextAttemptAt);
    assert.equal((await restored.state()).serverRetryAt, current.serverRetryAt);
  }
});
