import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SupportExports } from '../dist/support/export-job.js';

async function fixture(bytes = 255 * 1024 * 1024) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mizar-export-cache-'));
  const logs = join(root, 'logs');
  const stale = join(root, 'support-export', randomUUID());
  const part = join(stale, 'part-1.zip');
  await fs.mkdir(logs);
  await fs.mkdir(stale, { recursive: true });
  const handle = await fs.open(part, 'wx');
  await handle.truncate(bytes);
  await handle.close();
  const age = async () => fs.utimes(stale, new Date(0), new Date(0));
  await age();
  return { root, logs, stale, part, age, lease: join(stale, 'saving.lease') };
}
async function settle(owner) {
  const job = await owner.begin({}, { synthetic: true });
  for (let i = 0; i < 500; i++) {
    const status = owner.status(job.exportId);
    if (status?.settled) return status;
    await delay(10);
  }
  throw new Error('export did not settle');
}
function replaceRm(replacement) {
  fs.rm = replacement;
  syncBuiltinESMExports();
}
const realRm = fs.rm;

test('failed expired-cache cleanup releases its lease for immediate retry and restart', async () => {
  for (const restart of [false, true]) {
    const f = await fixture();
    try {
      const diagnostics = [];
      const owner = new SupportExports(
        f.logs,
        () => [],
        (error) => diagnostics.push(error),
      );
      let injected = false;
      replaceRm(async (path, options) => {
        if (path === f.part && !injected) {
          injected = true;
          throw Object.assign(new Error('transient cleanup denied'), { code: 'EACCES' });
        }
        return realRm(path, options);
      });
      const first = await settle(owner);
      assert.equal(first.phase, 'failed');
      assert.match(first.error, /export_cache_cleanup_failed/);
      assert.equal(diagnostics[0].cause.message, 'transient cleanup denied');
      assert.equal(diagnostics[0].cause.code, 'EACCES');
      assert.equal(injected, true);
      await assert.rejects(fs.lstat(f.lease), { code: 'ENOENT' });
      assert.equal((await fs.stat(f.part)).size, 255 * 1024 * 1024);
      assert.ok((await fs.stat(f.stale)).mtimeMs < Date.now() - 15 * 60_000);
      replaceRm(realRm);
      const second = await settle(restart ? new SupportExports(f.logs) : owner);
      assert.equal(second.phase, 'ready', second.error);
      assert.ok(second.parts.length > 0);
      await assert.rejects(fs.lstat(f.stale), { code: 'ENOENT' });
      assert.equal(
        (await fs.stat(join(f.root, 'support-export', second.exportId, second.parts[0].name))).size,
        second.parts[0].bytes,
      );
    } finally {
      replaceRm(realRm);
      await realRm(f.root, { recursive: true, force: true });
    }
  }
});

test('a native or unknown existing saving lease is never reclaimed by age or empty contents', async () => {
  const f = await fixture();
  const held = await fs.open(f.lease, 'wx');
  try {
    await f.age();
    const identity = await held.stat();
    for (let i = 0; i < 2; i++) {
      const result = await settle(new SupportExports(f.logs));
      assert.equal(result.phase, 'failed');
      assert.match(result.error, /export_cache_lease_unconfirmed/);
      assert.equal((await fs.lstat(f.lease)).ino, identity.ino);
      assert.equal((await fs.lstat(f.part)).size, 255 * 1024 * 1024);
    }
  } finally {
    await held.close();
    await realRm(f.root, { recursive: true, force: true });
  }
});

test('concurrent cleanup cannot remove the first owner lease or active contents', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  try {
    replaceRm(async (path, options) => {
      if (path === f.part) {
        entered();
        await gate;
      }
      return realRm(path, options);
    });
    const first = settle(new SupportExports(f.logs));
    await started;
    const owner = await fs.lstat(f.lease);
    await f.age();
    const second = await settle(new SupportExports(f.logs));
    assert.equal(second.phase, 'failed');
    assert.equal((await fs.lstat(f.lease)).ino, owner.ino);
    assert.equal((await fs.lstat(f.part)).size, 255 * 1024 * 1024);
    release();
    assert.equal((await first).phase, 'ready');
  } finally {
    release();
    replaceRm(realRm);
    await realRm(f.root, { recursive: true, force: true });
  }
});

test('failed cleanup does not release a replacement lease owned by someone else', async () => {
  const f = await fixture();
  try {
    replaceRm(async (path, options) => {
      if (path === f.part) {
        await fs.unlink(f.lease);
        await fs.writeFile(f.lease, 'another-owner', { flag: 'wx' });
        throw new Error('interrupted cleanup');
      }
      return realRm(path, options);
    });
    const result = await settle(new SupportExports(f.logs));
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /export_cache_cleanup_failed/);
    assert.equal(await fs.readFile(f.lease, 'utf8'), 'another-owner');
    assert.equal((await fs.lstat(f.part)).size, 255 * 1024 * 1024);
  } finally {
    replaceRm(realRm);
    await realRm(f.root, { recursive: true, force: true });
  }
});

test('final empty-directory removal cannot delete a newly acquired peer lease', async () => {
  const f = await fixture();
  const realRmdir = fs.rmdir;
  let peer;
  try {
    fs.rmdir = async (path, options) => {
      if (path === f.stale) peer = await fs.open(f.lease, 'wx');
      return realRmdir(path, options);
    };
    syncBuiltinESMExports();
    const result = await settle(new SupportExports(f.logs));
    assert.equal(result.phase, 'ready', result.error);
    assert.ok(peer);
    assert.equal((await fs.lstat(f.lease)).ino, (await peer.stat()).ino);
  } finally {
    fs.rmdir = realRmdir;
    syncBuiltinESMExports();
    await peer?.close();
    await realRm(f.root, { recursive: true, force: true });
  }
});

test('small measurable stale-cache cleanup failure does not block a new export', async () => {
  const f = await fixture(4096);
  const diagnostics = [];
  try {
    replaceRm(async (path, options) => {
      if (path === f.part)
        throw Object.assign(new Error('cache permission denied'), { code: 'EACCES' });
      return realRm(path, options);
    });
    const owner = new SupportExports(
      f.logs,
      () => [],
      (error, id, stage) => diagnostics.push({ error, id, stage }),
    );
    const result = await settle(owner);
    assert.equal(result.phase, 'ready', result.error);
    assert.equal(result.cleanupStatus, 'unconfirmed');
    assert.ok(result.parts.length > 0);
    assert.equal((await fs.stat(f.part)).size, 4096);
    await assert.rejects(fs.lstat(f.lease), { code: 'ENOENT' });
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].id, result.exportId);
    assert.equal(diagnostics[0].stage, 'cleanup');
    assert.equal(diagnostics[0].error.cause.code, 'EACCES');
    assert.equal(diagnostics[0].error.cause.message, 'cache permission denied');
  } finally {
    replaceRm(realRm);
    await realRm(f.root, { recursive: true, force: true });
  }
});

test('unsafe retained cache still blocks admission after cleanup failure', async () => {
  const f = await fixture(4096);
  try {
    replaceRm(async (path, options) => {
      if (path === f.part) {
        await fs.rename(f.stale, `${f.stale}.original`);
        await fs.mkdir(f.stale);
        throw new Error('directory replaced during cleanup');
      }
      return realRm(path, options);
    });
    const result = await settle(new SupportExports(f.logs));
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /export_cache_directory_changed/);
    assert.equal((await fs.stat(join(`${f.stale}.original`, 'part-1.zip'))).size, 4096);
  } finally {
    replaceRm(realRm);
    await realRm(f.root, { recursive: true, force: true });
  }
});

test('unmeasurable retained cache blocks admission instead of guessing a budget', async () => {
  const f = await fixture(4096);
  const realLstat = fs.lstat;
  try {
    replaceRm(async (path, options) => {
      if (path === f.part) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      return realRm(path, options);
    });
    fs.lstat = async (path, options) => {
      if (path === f.part)
        throw Object.assign(new Error('cannot measure retained content'), { code: 'EACCES' });
      return realLstat(path, options);
    };
    syncBuiltinESMExports();
    const result = await settle(new SupportExports(f.logs));
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /cannot measure retained content/);
    assert.equal((await fs.stat(f.part)).size, 4096);
    await assert.rejects(realLstat(f.lease), { code: 'ENOENT' });
  } finally {
    fs.lstat = realLstat;
    replaceRm(realRm);
    await realRm(f.root, { recursive: true, force: true });
  }
});
