import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPromotion } from './verify-promotion.mjs';
import { assertPublishedAssets, assertPublication } from './update-publication.mjs';

it('requires every original published asset before treating a promotion retry as complete', () => {
  const identity = { tag: 'v1.1.0', gitSha: 'a'.repeat(40) };
  const expected = [
    'product.zip',
    'Setup.exe',
    'update-manifest.json',
    'update-provenance.json',
    'evidence.zip',
    'promotion-identity.json',
    'promotion-ci.json',
  ].map((name, i) => ({
    name,
    size: i + 1,
    sha256: String(i).repeat(64),
  }));
  const release = {
    id: 42,
    tag_name: identity.tag,
    draft: false,
    prerelease: false,
    published_at: '2026-10-10T00:00:00Z',
    assets: expected.map((a) => ({
      ...a,
      digest: `sha256:${a.sha256}`,
      browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/${a.name}`,
    })),
  };
  const ref = { object: { type: 'commit', sha: identity.gitSha } };
  expect(() => assertPublishedAssets(release, ref, identity, expected)).not.toThrow();
  for (let i = 0; i < expected.length; i++) {
    expect(() =>
      assertPublishedAssets(
        { ...release, assets: release.assets.filter((_, n) => n !== i) },
        ref,
        identity,
        expected,
      ),
    ).toThrow();
    expect(() =>
      assertPublishedAssets(
        {
          ...release,
          assets: release.assets.map((a, n) => (n === i ? { ...a, digest: 'sha256:wrong' } : a)),
        },
        ref,
        identity,
        expected,
      ),
    ).toThrow();
  }
  expect(() =>
    assertPublishedAssets({ ...release, draft: true }, ref, identity, expected),
  ).toThrow();
  expect(() =>
    assertPublishedAssets({ ...release, prerelease: true }, ref, identity, expected),
  ).toThrow();
});

it('binds the publication authorization to the exact manifest and actual release identity', () => {
  const bytes = Buffer.from('original update manifest'),
    manifest = { version: '1.1.0', gitSha: 'a'.repeat(40) };
  const receipt = {
    schemaVersion: 'mizar.update-publication.v1',
    repository: 'Starfie1d1272/Mizar',
    ...manifest,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    releaseId: 42,
    publishedAt: '2026-10-10T00:00:00Z',
    promotionSha: 'b'.repeat(40),
  };
  expect(() => assertPublication(receipt, bytes, manifest)).not.toThrow();
  for (const patch of [
    { version: '1.2.0' },
    { gitSha: 'c'.repeat(40) },
    { manifestSha256: 'd'.repeat(64) },
    { promotionSha: 'main' },
    { releaseId: 0 },
    { publishedAt: 'not-published' },
  ])
    expect(() => assertPublication({ ...receipt, ...patch }, bytes, manifest)).toThrow();
});

it.each([
  ['Mizar-v1.0.0-rc.7-Windows-x64', '1.0.0-rc.7', '-Setup.exe'],
  ['Mizar-v1.0.0-Windows-x64', '1.0.0', '-Setup.exe'],
  ['Mizar-RC7-win-x64-portable-aaaaaaa', '1.0.0-rc.7', '-Setup.exe'],
])(
  'verifies %s and rejects mismatched promotion identities',
  async (name, appVersion, setupSuffix) => {
    const root = await mkdtemp(join(tmpdir(), 'mizar-promotion-'));
    const product = join(root, 'product');
    const extracted = join(root, 'extracted');
    const bundle = join(extracted, name);
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    const files = [
      'Mizar.exe',
      'resources/runtime/node.exe',
      'resources/app/dist/server.js',
      'resources/web/dist/index.html',
      'resources/scripts/product-runtime.mjs',
      'resources/scripts/product-logs.mjs',
    ].sort();
    try {
      await mkdir(product, { recursive: true });
      for (const file of files) {
        await mkdir(join(bundle, file, '..'), { recursive: true });
        await writeFile(join(bundle, file), 'fixture');
      }
      const contentDigest = hash(files.map((file) => `${file}\0${hash('fixture')}\n`).join(''));
      const artifact = {
        repository: 'Starfie1d1272/Mizar',
        productSchemaVersion: 1,
        desktopHost: 'tauri2',
        platform: 'win32-x64',
        desktopBuildProfile: 'release',
        appVersion,
        gitSha: 'a'.repeat(40),
        artifactSha256: contentDigest,
      };
      await mkdir(join(bundle, 'resources/metadata'), { recursive: true });
      const json = JSON.stringify(artifact);
      await writeFile(join(bundle, 'resources/metadata/artifact.json'), json);
      await writeFile(
        join(bundle, 'resources/metadata/SHA256SUMS'),
        [
          ...files.map((file) => `${hash('fixture')}  ${file}`),
          `${hash(json)}  resources/metadata/artifact.json`,
        ].join('\n'),
      );
      const archive = `${name}.zip`;
      await writeFile(join(product, archive), 'original zipped fixture bytes');
      const manifest = {
        appVersion: artifact.appVersion,
        gitSha: artifact.gitSha,
        desktopBuildProfile: 'release',
        archive,
        archiveSha256: hash('original zipped fixture bytes'),
        contentDigest,
      };
      await writeFile(join(product, 'release-manifest.json'), JSON.stringify(manifest));
      await writeFile(
        join(product, `${archive}.sha256`),
        `${manifest.archiveSha256}  ${archive}\n`,
      );
      const options = {
        product,
        extracted,
        tag: `v${appVersion}`,
        sourceSha: artifact.gitSha,
        binaryVersion: artifact.appVersion,
      };
      expect(await verifyPromotion(options)).toMatchObject({
        archiveSha256: manifest.archiveSha256,
      });
      await expect(verifyPromotion({ ...options, sourceSha: 'b'.repeat(40) })).rejects.toThrow(
        '来源',
      );
      await expect(verifyPromotion({ ...options, tag: 'v1.0.0-rc.8' })).rejects.toThrow('标签');
      await expect(verifyPromotion({ ...options, binaryVersion: '1.0.0-rc.6' })).rejects.toThrow(
        'EXE',
      );
      const distribution = {
        schemaVersion: 1,
        gitSha: artifact.gitSha,
        appVersion: artifact.appVersion,
        contentDigest,
        originalArchiveSha256: manifest.archiveSha256,
        archive: archive.replace('.zip', setupSuffix),
        archiveSha256: hash('setup fixture'),
        archiveBytes: Buffer.byteLength('setup fixture'),
        format: 'nsis-setup',
        installerLicense: 'NSIS-LICENSE.txt',
        installerLicenseSha256: hash('license fixture'),
        installerVersion: 'v3.11',
        installerCompilerSha256: hash('compiler fixture'),
        installerScriptSha256: hash('script fixture'),
      };
      await writeFile(join(product, distribution.installerLicense), 'license fixture');
      await writeFile(join(product, distribution.archive), 'setup fixture');
      await writeFile(
        join(product, `${distribution.archive}.sha256`),
        `${distribution.archiveSha256}  ${distribution.archive}\n`,
      );
      await writeFile(join(product, 'distribution-manifest.json'), JSON.stringify(distribution));
      expect((await verifyPromotion(options)).distribution).toEqual(distribution);
      await writeFile(join(product, distribution.archive), 'tampered');
      await expect(verifyPromotion(options)).rejects.toThrow('安装包摘要');
      await writeFile(join(product, distribution.archive), 'setup fixture');
      await writeFile(
        join(product, 'distribution-manifest.json'),
        JSON.stringify({ ...distribution, contentDigest: 'b'.repeat(64) }),
      );
      await expect(verifyPromotion(options)).rejects.toThrow('安装包身份');
      await rm(join(product, 'distribution-manifest.json'));
      await expect(verifyPromotion(options)).rejects.toThrow('缺少');
      await rm(join(product, distribution.archive));
      await writeFile(join(product, archive), 'tampered');
      await expect(verifyPromotion(options)).rejects.toThrow('ZIP');
      await writeFile(join(product, archive), 'original zipped fixture bytes');
      await writeFile(join(bundle, 'resources/web/dist/index.html'), 'tampered');
      await expect(verifyPromotion(options)).rejects.toThrow('校验');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
