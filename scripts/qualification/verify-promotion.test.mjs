import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPromotion } from './verify-promotion.mjs';

it('rejects wrong source, tag, ZIP digest, payload and compiled version during promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-promotion-'));
  const product = join(root, 'product');
  const extracted = join(root, 'extracted');
  const bundle = join(extracted, 'Mizar-RC7-test');
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
      appVersion: '1.0.0-rc.7',
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
    const archive = 'Mizar-RC7-test.zip';
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
    await writeFile(join(product, `${archive}.sha256`), `${manifest.archiveSha256}  ${archive}\n`);
    const options = {
      product,
      extracted,
      tag: 'v1.0.0-rc.7',
      sourceSha: artifact.gitSha,
      binaryVersion: artifact.appVersion,
    };
    expect(await verifyPromotion(options)).toMatchObject({ archiveSha256: manifest.archiveSha256 });
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
      archive: archive.replace('.zip', '-extract.exe'),
      archiveSha256: hash('sfx fixture'),
      archiveBytes: Buffer.byteLength('sfx fixture'),
      format: '7zip-gui-sfx-lzma2-solid',
      extractorLicense: '7zip-LICENSE.txt',
      extractorLicenseSha256: hash('license fixture'),
      extractorSourceArchive: '7z2501-src.7z',
      extractorSourceSha256: hash('source fixture'),
      extractorSourceUrl: 'https://www.7-zip.org/a/7z2501-src.7z',
    };
    await writeFile(join(product, distribution.extractorLicense), 'license fixture');
    await writeFile(join(product, distribution.extractorSourceArchive), 'source fixture');
    await writeFile(join(product, distribution.archive), 'sfx fixture');
    await writeFile(
      join(product, `${distribution.archive}.sha256`),
      `${distribution.archiveSha256}  ${distribution.archive}\n`,
    );
    await writeFile(join(product, 'distribution-manifest.json'), JSON.stringify(distribution));
    expect((await verifyPromotion(options)).distribution).toEqual(distribution);
    await writeFile(join(product, distribution.archive), 'tampered');
    await expect(verifyPromotion(options)).rejects.toThrow('自解压包摘要');
    await writeFile(join(product, distribution.archive), 'sfx fixture');
    await writeFile(
      join(product, 'distribution-manifest.json'),
      JSON.stringify({ ...distribution, contentDigest: 'b'.repeat(64) }),
    );
    await expect(verifyPromotion(options)).rejects.toThrow('自解压包身份');
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
});
