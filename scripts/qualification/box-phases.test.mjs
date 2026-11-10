import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import { RESOURCE_ASSET_NAMES } from '../../packages/resource-pack-contract/catalog.mjs';
import { createBoxPlan } from './box-phase-contract.mjs';
import { digest } from './box-sync.mjs';
import {
  downloadLane,
  verifyLane,
  finalCheck,
  updatePointer,
  verifyPointer,
  boxPhaseDiagnostic,
} from './box-phases.mjs';

const item = (name, bytes) => ({ name, size: bytes.length, sha256: digest(bytes) });

test('invalid plan reports a fixed reason and never echoes arbitrary external errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-box-invalid-'));
  try {
    await writeFile(join(directory, 'plan.json'), '{}\n');
    const script = fileURLToPath(new URL('./box-phases.mjs', import.meta.url));
    await assert.rejects(
      promisify(execFile)(process.execPath, [script, 'download', directory, 'runtime', 'core']),
      (error) =>
        /reason=BOX_PLAN_IDENTITY \(Invalid Box plan identity\)/.test(error.stderr) &&
        /lane=runtime asset=core/.test(error.stderr),
    );
    const secret = 'secret-token';
    const url = 'https://host.example/private?signature=abc';
    const text = boxPhaseDiagnostic('download', 'runtime', 'core', new Error(`${secret} ${url}`));
    assert.match(text, /reason=BOX_PHASE_ERROR/);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(url));
    const missing = boxPhaseDiagnostic(
      'transfer-verified-runtime',
      'runtime',
      'core',
      Object.assign(new Error(`${secret} ${url}`), { code: 'ENOENT' }),
    );
    assert.match(
      missing,
      /transfer-verified-runtime.*lane=runtime asset=core.*reason=BOX_FILE_MISSING/,
    );
    const external = boxPhaseDiagnostic(
      'transfer-verified-runtime',
      'runtime',
      'core',
      new Error(`${secret} ${url}`),
    );
    assert.match(
      external,
      /transfer-verified-runtime.*lane=runtime asset=core.*reason=BOX_PHASE_ERROR/,
    );
    assert.ok(!missing.includes(secret) && !missing.includes(url));
    assert.ok(!external.includes(secret) && !external.includes(url));
    const receipt = boxPhaseDiagnostic(
      'verify',
      'runtime',
      'core',
      new Error('Invalid Box phase receipt'),
      'Mizar-v1.10.1-Windows-x64-Core-Setup.exe',
    );
    assert.match(receipt, /reason=BOX_RECEIPT_INVALID/);
    assert.match(receipt, /name=Mizar-v1\.10\.1-Windows-x64-Core-Setup\.exe/);
    assert.ok(
      !boxPhaseDiagnostic('verify', 'runtime', 'core', new Error('oops'), secret).includes(secret),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
function fakeBox() {
  const directories = new Set([
    '/',
    '/Archive',
    '/Stable',
    '/Stable/Downloads',
    '/Runtime',
    '/Resources',
  ]);
  const files = new Map();
  const writes = [];
  const reads = [];
  return {
    directories,
    files,
    writes,
    reads,
    async initialize() {},
    async list(path) {
      return [
        ...[...directories]
          .filter((p) => p !== path && dirname(p) === path)
          .map((p) => ({ name: p.slice(path === '/' ? 1 : path.length + 1), type: 'dir' })),
        ...[...files.keys()]
          .filter((p) => dirname(p) === path)
          .map((p) => ({ name: p.slice(path === '/' ? 1 : path.length + 1), type: 'file' })),
      ];
    },
    async api(_endpoint, path, method, body) {
      if (method === 'POST' && body?.operation === 'mkdir') directories.add(path);
      else if (method === 'DELETE') directories.delete(path);
      else throw new Error('unexpected fake API');
    },
    async upload(path, name, bytes) {
      files.set(`${path}/${name}`, Buffer.from(bytes));
      writes.push(`${path}/${name}`);
    },
    async uploadChunks(path, name, bytes) {
      files.set(`${path}/${name}`, Buffer.from(bytes));
      writes.push(`${path}/${name}`);
    },
    async hash(path) {
      reads.push(path);
      const bytes = files.get(path);
      assert.ok(bytes, path);
      return { size: bytes.length, sha256: digest(bytes) };
    },
    async move(from, to, name) {
      const src = `${from}/${name}`;
      assert.ok(files.has(src));
      files.set(`${to}/${name}`, files.get(src));
      files.delete(src);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}
test('verified GitHub lanes publish only original metadata, preserve history and reject rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-box-phases-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = 'b'.repeat(40),
    archiveSha = 'c'.repeat(64);
  const core = { appVersion: '1.10.0', gitSha: sha, archiveSha256: archiveSha };
  const carrier = makeMachineMetadata(
    new Map([
      ['core-release-manifest.json', Buffer.from(JSON.stringify(core))],
      ...Object.values(RESOURCE_ASSET_NAMES).map((name) => [
        name,
        Buffer.from(name === 'resource-catalog.json' ? '{}' : 'test-proof'),
      ]),
    ]),
  );
  const index = Buffer.from('signed-index');
  const assets = {
    runtime: [
      item('machine-metadata.json', carrier),
      item('Mizar-v1.10.0-Windows-x64-Core-Setup.exe', Buffer.from('core')),
    ],
    resources: [item('Mizar-official-epl-default-1.0.0.zip', Buffer.from('pack'))],
    downloads: [item('Mizar-v1.10.0-Windows-x64-WebInstaller.exe', Buffer.from('web'))],
  };
  const plan = createBoxPlan({
    runId: '123',
    attempt: 1,
    tag: 'v1.10.0',
    releaseId: 7,
    sourceSha: sha,
    coreArchiveSha: archiveSha,
    assets,
    updateIndex: item('update-index.json', index),
  });
  const keys = ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'BOX_PLAN_SHA256'];
  const before = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) =>
      before[index] === undefined ? delete process.env[key] : (process.env[key] = before[index]),
    ),
  );
  process.env.GITHUB_RUN_ID = '123';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.BOX_PLAN_SHA256 = digest(plan);
  await writeFile(join(root, 'plan.json'), plan);
  await writeFile(join(root, 'machine-metadata.json'), carrier);
  await writeFile(join(root, 'update-index.json'), index);
  await writeFile(
    join(root, 'release.json'),
    JSON.stringify({
      id: 7,
      tag_name: 'v1.10.0',
      draft: false,
      prerelease: false,
      published_at: '2026-01-01',
    }),
  );
  const payload = new Map([
    [assets.runtime[1].name, Buffer.from('core')],
    [assets.resources[0].name, Buffer.from('pack')],
    [assets.downloads[0].name, Buffer.from('web')],
  ]);
  const options = {
    download: async (_release, _tag, name) => payload.get(name),
    verify: async () => {},
    inventory: async () => assets.resources,
  };
  await downloadLane(root, 'runtime', 'metadata', options);
  await downloadLane(root, 'runtime', 'core', options);
  for (const lane of ['resources', 'downloads']) await downloadLane(root, lane, undefined, options);

  const box = fakeBox();
  const bootstrapPath = join(root, 'payload', 'downloads', assets.downloads[0].name);
  await writeFile(bootstrapPath, 'tampered');
  await assert.rejects(verifyLane(root, 'downloads'), /原字节不一致/);
  assert.equal(box.writes.length, 0);
  await writeFile(bootstrapPath, Buffer.from('web'));
  for (const lane of ['runtime', 'resources', 'downloads']) await verifyLane(root, lane);
  const receipts = join(root, 'receipt');
  const missing = join(receipts, 'resources.json');
  const saved = await readFile(missing);
  await rm(missing);
  await assert.rejects(finalCheck(root, receipts, box));
  await assert.rejects(updatePointer(root, receipts, box));
  assert.equal(box.writes.length, 0);
  await writeFile(missing, saved);
  // Keep every historical file, including old Core and unrelated user resources.
  box.directories.add('/Runtime/v1.10.0');
  box.files.set('/Runtime/v1.10.0/old-backend.exe', Buffer.from('old'));
  box.files.set('/Stable/Downloads/old.exe', Buffer.from('old'));
  const metadataPath = '/Runtime/v1.10.0/machine-metadata.json';
  const uncertain = fakeBox();
  uncertain.upload = async () => {
    throw new Error('uncertain write');
  };
  await assert.rejects(finalCheck(root, receipts, uncertain), /uncertain write/);
  await assert.rejects(updatePointer(root, receipts, uncertain));
  box.files.set(metadataPath, Buffer.from('conflict'));
  await assert.rejects(finalCheck(root, receipts, box), /内容冲突/);
  assert.equal(box.writes.length, 0);
  box.files.delete(metadataPath);
  await finalCheck(root, receipts, box);
  assert.ok(box.reads.filter((path) => path === metadataPath).length >= 2);
  await rm(join(root, 'final-verified.json'));
  await finalCheck(root, receipts, box);
  assert.deepEqual(box.writes, [metadataPath]);
  await updatePointer(root, receipts, box);
  await verifyPointer(root, receipts, box);
  await updatePointer(root, receipts, box);
  assert.deepEqual(box.writes, [metadataPath, '/Updates/latest.json']);
  assert.deepEqual(box.files.get('/Updates/latest.json'), index);
  assert.equal(box.files.get('/Runtime/v1.10.0/old-backend.exe').toString(), 'old');
  assert.equal(box.files.get('/Stable/Downloads/old.exe').toString(), 'old');
  let previousVersion = '1.11.0';
  box.readIndex = async () =>
    Buffer.from(
      JSON.stringify({
        schemaVersion: 'mizar.update-index.v2',
        manifestBase64: Buffer.from(JSON.stringify({ version: previousVersion })).toString(
          'base64',
        ),
      }),
    );
  box.files.set('/Updates/latest.json', Buffer.from('newer-index'));
  await assert.rejects(updatePointer(root, receipts, box), /拒绝回退/);
  previousVersion = '1.10.0';
  await assert.rejects(updatePointer(root, receipts, box), /拒绝回退/);
  assert.deepEqual(box.writes, [metadataPath, '/Updates/latest.json']);
});

test('prepare writes only metadata and the exact authenticated asset plan', async (t) => {
  const { prepare } = await import('./box-phases.mjs');
  const { readBoxPlan } = await import('./box-phase-contract.mjs');
  const root = await mkdtemp(join(tmpdir(), 'mizar-box-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT];
  t.after(() => {
    for (const [index, key] of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].entries())
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
  });
  process.env.GITHUB_RUN_ID = '123';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  const tag = 'v1.10.0',
    sha = 'b'.repeat(40),
    coreSha = 'c'.repeat(64);
  const carrier = Buffer.from('small-metadata'),
    backend = item(`Mizar-${tag}-Windows-x64-Core-Setup.exe`, Buffer.from('core'));
  const bootstrap = item(`Mizar-${tag}-Windows-x64-WebInstaller.exe`, Buffer.from('web'));
  const pack = item('Mizar-official-epl-default-1.0.0.zip', Buffer.from('pack'));
  const release = {
    id: 7,
    assets: [
      {
        name: pack.name,
        size: pack.size,
        digest: `sha256:${pack.sha256}`,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${pack.name}`,
      },
    ],
  };
  const identity = {
    version: '1.10.0',
    gitSha: sha,
    core: { archiveSha256: coreSha },
    originals: new Map(),
    runtime: [{ ...item('machine-metadata.json', carrier), bytes: carrier }, backend],
    bootstrap,
    release,
  };
  const input = join(root, 'release.json');
  await writeFile(input, JSON.stringify({ tag }));
  const destination = join(root, 'plan');
  const result = await prepare(destination, input, {
    loadIdentity: async (_tag, options) => {
      assert.equal(options.runtime, false);
      assert.equal(options.bootstrap, false);
      return identity;
    },
    loadIndex: async () => Buffer.from('index'),
    verifyResources: async () => ({
      entry: { archive: { name: pack.name, bytes: pack.size, sha256: pack.sha256 } },
    }),
  });
  const bytes = await readFile(join(destination, 'plan.json'));
  assert.equal(result.planSha256, digest(bytes));
  const plan = readBoxPlan(bytes);
  assert.deepEqual(plan.assets.runtime, [item('machine-metadata.json', carrier), backend]);
  assert.deepEqual(plan.assets.resources, [pack]);
  assert.deepEqual(plan.assets.downloads, [bootstrap]);
  await assert.rejects(readFile(join(destination, backend.name)), { code: 'ENOENT' });
});
