import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { basename, dirname } from 'node:path';
import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import {
  RESOURCE_ASSET_NAMES,
  createResourceCatalog,
  createResourceDescriptor,
} from '../../packages/resource-pack-contract/catalog.mjs';
import { jsonBytes } from '../../packages/resource-pack-contract/content.mjs';
import { digest, syncBoxMetadata, verifyResourceMetadata } from './box-sync.mjs';

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
    async hash(path) {
      reads.push(path);
      const bytes = files.get(path);
      assert.ok(bytes, path);
      return { size: bytes.length, sha256: digest(bytes) };
    },
  };
}

function makeFixtures(tag = 'v1.10.0') {
  const version = tag.slice(1);
  const sha = 'b'.repeat(40);
  const archiveSha = 'c'.repeat(64);
  const resourceZipName = 'Mizar-official-epl-default-1.0.0.zip';
  const resourceZipBytes = Buffer.from('pack');
  const core = { appVersion: version, gitSha: sha, archiveSha256: archiveSha };
  const carrier = makeMachineMetadata(
    new Map([
      ['core-release-manifest.json', Buffer.from(JSON.stringify(core))],
      ...Object.values(RESOURCE_ASSET_NAMES).map((name) => [
        name,
        Buffer.from(name === 'resource-catalog.json' ? '{}' : 'test-proof'),
      ]),
    ]),
  );
  const updateIndex = Buffer.from('signed-index');
  const release = {
    id: 7,
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    assets: [
      {
        name: resourceZipName,
        size: resourceZipBytes.length,
        digest: `sha256:${digest(resourceZipBytes)}`,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${resourceZipName}`,
      },
    ],
  };
  const identity = {
    name: `Mizar-${tag}-Windows-x64-Setup.exe`,
    version,
    size: 100,
    sha256: 'd'.repeat(64),
    gitSha: sha,
    releaseId: release.id,
    release,
    core,
    originals: new Map([['core-release-manifest.json', Buffer.from(JSON.stringify(core))]]),
    runtime: [
      {
        name: 'machine-metadata.json',
        size: carrier.length,
        sha256: digest(carrier),
        bytes: carrier,
      },
      {
        name: `Mizar-${tag}-Windows-x64-Core-Setup.exe`,
        size: 50,
        sha256: 'e'.repeat(64),
      },
    ],
    bootstrap: {
      name: `Mizar-${tag}-Windows-x64-WebInstaller.exe`,
      version,
      gitSha: sha,
      releaseId: release.id,
      size: 3,
      sha256: digest(Buffer.from('web')),
      data: Buffer.from('web'),
    },
  };
  const resources = {
    entry: {
      archive: {
        name: resourceZipName,
        bytes: resourceZipBytes.length,
        sha256: digest(resourceZipBytes),
      },
    },
  };
  return { tag, version, carrier, updateIndex, release, identity, resources };
}

test('sequential sync verifies metadata without large downloads, preserves history and rejects rollback', async () => {
  const { tag, updateIndex, release, identity, resources } = makeFixtures('v1.10.0');
  const box = fakeBox();
  box.directories.add('/Runtime/v1.10.0');
  box.files.set('/Runtime/v1.10.0/old-backend.exe', Buffer.from('old'));
  box.files.set('/Stable/Downloads/old.exe', Buffer.from('old'));

  const seenOptions = [];
  const deps = {
    tag,
    box,
    readRelease: async (t) => ({
      tag: t,
      release,
      ref: { object: { type: 'commit', sha: identity.gitSha } },
    }),
    loadIdentity: async (_tag, options) => {
      seenOptions.push(options);
      return identity;
    },
    loadIndex: async () => updateIndex,
    verifyResources: async () => resources,
  };

  const metadataPath = '/Runtime/v1.10.0/machine-metadata.json';

  // Conflict on existing machine-metadata.json stops without overwriting
  box.files.set(metadataPath, Buffer.from('conflict'));
  await assert.rejects(syncBoxMetadata(deps), /内容冲突/);
  assert.equal(box.writes.length, 0);
  box.files.delete(metadataPath);

  // Successful sequential sync
  const result = await syncBoxMetadata(deps);
  assert.equal(result.prerelease, false);
  assert.deepEqual(seenOptions[0].runtime, false);
  assert.deepEqual(seenOptions[0].bootstrap, true);
  assert.deepEqual(box.writes, [metadataPath, '/Updates/latest.json']);
  assert.ok(box.reads.includes(metadataPath));
  assert.ok(box.reads.includes('/Updates/latest.json'));
  assert.deepEqual(box.files.get('/Updates/latest.json'), updateIndex);
  assert.equal(box.files.get('/Runtime/v1.10.0/old-backend.exe').toString(), 'old');
  assert.equal(box.files.get('/Stable/Downloads/old.exe').toString(), 'old');

  // Idempotent re-run does not re-upload identical files
  await syncBoxMetadata(deps);
  assert.deepEqual(box.writes, [metadataPath, '/Updates/latest.json']);

  // Reject rollback or same-version overwrite with different content
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
  await assert.rejects(syncBoxMetadata(deps), /拒绝回退/);
  previousVersion = '1.10.0';
  await assert.rejects(syncBoxMetadata(deps), /拒绝回退/);
  assert.deepEqual(box.writes, [metadataPath, '/Updates/latest.json']);
});

test('skips prerelease tags without touching Box or GitHub release', async () => {
  let touched = false;
  const prereleaseFlags = [];
  const result = await syncBoxMetadata({
    tag: 'v1.10.0-rc.1',
    createBox: () => {
      touched = true;
      return fakeBox();
    },
    readRelease: async () => {
      touched = true;
      throw new Error('should not read release');
    },
    onPrerelease: async (flag) => prereleaseFlags.push(flag),
  });
  assert.equal(result.prerelease, true);
  assert.deepEqual(prereleaseFlags, [true]);
  assert.equal(touched, false);
});

test('requires attested WebInstaller bytes and matching Release resource archive identity', async () => {
  const { tag, updateIndex, release, identity, resources } = makeFixtures('v1.10.0');
  const box = fakeBox();

  // Missing WebInstaller attested bytes (e.g. bootstrap: false or missing asset) must fail before Box writes
  const unverifiedBootstrap = {
    ...identity,
    bootstrap: { ...identity.bootstrap, data: undefined },
  };
  await assert.rejects(
    syncBoxMetadata({
      tag,
      box,
      readRelease: async (t) => ({
        tag: t,
        release,
        ref: { object: { type: 'commit', sha: identity.gitSha } },
      }),
      loadIdentity: async () => unverifiedBootstrap,
      loadIndex: async () => updateIndex,
      verifyResources: async () => resources,
    }),
    /仅同步已签拆分发行/,
  );
  assert.equal(box.writes.length, 0);

  // Mismatched resource archive digest in Release API must fail before Box writes
  const badResources = {
    entry: {
      archive: { ...resources.entry.archive, sha256: 'f'.repeat(64) },
    },
  };
  await assert.rejects(
    syncBoxMetadata({
      tag,
      box,
      readRelease: async (t) => ({
        tag: t,
        release,
        ref: { object: { type: 'commit', sha: identity.gitSha } },
      }),
      loadIdentity: async () => identity,
      loadIndex: async () => updateIndex,
      verifyResources: async () => badResources,
    }),
    /资源归档与公开 Release 不一致/,
  );
  assert.equal(box.writes.length, 0);
});

test('verifyResourceMetadata parses descriptor/catalog, verifies 3 attestations and rejects publication digest mismatch', async () => {
  const gitSha = 'a'.repeat(40);
  const promotionSha = 'b'.repeat(40);
  const core = {
    appVersion: '1.10.0',
    gitSha,
    archive: 'Mizar-v1.10.0-Windows-x64-Core.zip',
    archiveSha256: 'c'.repeat(64),
  };
  const archive = {
    name: 'Mizar-official-epl-default-1.0.0.zip',
    format: 'zip',
    bytes: 42,
    sha256: 'd'.repeat(64),
  };
  const descriptor = createResourceDescriptor({
    core,
    packVersion: '1.0.0',
    archive,
    manifestSha256: 'e'.repeat(64),
    sequence: 1,
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-06-01T00:00:00Z',
  });
  const descriptorBytes = jsonBytes(descriptor);
  const publicationBytes = Buffer.from('signed-publication');
  const catalog = createResourceCatalog(
    descriptor,
    descriptorBytes,
    promotionSha,
    digest(publicationBytes),
  );
  const catalogBytes = jsonBytes(catalog);
  const originals = new Map([
    [RESOURCE_ASSET_NAMES.descriptor, descriptorBytes],
    [RESOURCE_ASSET_NAMES.descriptorQualification, Buffer.from('qual-bundle')],
    [RESOURCE_ASSET_NAMES.catalog, catalogBytes],
    [RESOURCE_ASSET_NAMES.catalogPromotion, Buffer.from('catalog-bundle')],
    [RESOURCE_ASSET_NAMES.archiveQualification, Buffer.from('archive-bundle')],
    [RESOURCE_ASSET_NAMES.publication, publicationBytes],
    [RESOURCE_ASSET_NAMES.publicationPromotion, Buffer.from('pub-bundle')],
  ]);

  const attested = [];
  const parsed = await verifyResourceMetadata({ gitSha, core, originals }, async ([subject]) => {
    attested.push({
      file: basename(subject.file),
      bundle: basename(subject.bundle),
      sourceSha: subject.sourceSha,
      workflow: subject.workflow,
    });
  });
  assert.equal(parsed.entry.archive.name, archive.name);
  assert.deepEqual(attested, [
    {
      file: RESOURCE_ASSET_NAMES.descriptor,
      bundle: RESOURCE_ASSET_NAMES.descriptorQualification,
      sourceSha: gitSha,
      workflow: undefined,
    },
    {
      file: RESOURCE_ASSET_NAMES.catalog,
      bundle: RESOURCE_ASSET_NAMES.catalogPromotion,
      sourceSha: promotionSha,
      workflow: 'promotion',
    },
    {
      file: RESOURCE_ASSET_NAMES.publication,
      bundle: RESOURCE_ASSET_NAMES.publicationPromotion,
      sourceSha: promotionSha,
      workflow: 'promotion',
    },
  ]);

  originals.set(RESOURCE_ASSET_NAMES.publication, Buffer.from('tampered-publication'));
  await assert.rejects(
    verifyResourceMetadata({ gitSha, core, originals }, async () => {}),
    /资源声明与签发目录不一致/,
  );
});

test('aborts before publishing /Updates/latest.json when machine-metadata.json upload fails', async () => {
  const { tag, updateIndex, release, identity, resources } = makeFixtures('v1.10.0');
  const box = fakeBox();
  box.upload = async () => {
    throw new Error('metadata upload failed');
  };

  await assert.rejects(
    syncBoxMetadata({
      tag,
      box,
      readRelease: async (t) => ({
        tag: t,
        release,
        ref: { object: { type: 'commit', sha: identity.gitSha } },
      }),
      loadIdentity: async () => identity,
      loadIndex: async () => updateIndex,
      verifyResources: async () => resources,
    }),
    /metadata upload failed/,
  );
  assert.equal(box.files.has('/Updates/latest.json'), false);
  assert.equal(box.writes.length, 0);
});
