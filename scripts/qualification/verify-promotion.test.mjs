import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifyPromotion } from './verify-promotion.mjs';
import { assertPublishedAssets, assertPublication } from './update-publication.mjs';
import { makeUpdateIndex } from './update-index.mjs';
import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';

it('completes the real publication readback CLI without a module wait cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar publication CLI '));
  const product = join(root, 'product');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const gitSha = 'a'.repeat(40),
    promotionSha = 'b'.repeat(40),
    version = '1.2.0';
  const web = `Mizar-v${version}-Windows-x64-WebInstaller.exe`;
  const originals = new Map(
    ['full.zip', 'FullSetup.exe', 'CoreSetup.exe', web].map((name) => [name, Buffer.from(name)]),
  );
  const manifestBytes = Buffer.from(JSON.stringify({ version, gitSha }));
  originals.set('update-manifest.json', manifestBytes);
  const publication = {
    schemaVersion: 'mizar.update-publication.v1',
    repository: 'Starfie1d1272/Mizar',
    version,
    gitSha,
    promotionSha,
    manifestSha256: hash(manifestBytes),
    releaseId: 42,
    publishedAt: '2026-10-10T00:00:00Z',
  };
  const index = makeUpdateIndex(
    manifestBytes,
    Buffer.from('{}'),
    Buffer.from(JSON.stringify(publication)),
    Buffer.from('{}'),
  );
  const carrier = makeMachineMetadata(new Map([['update-index.json', index]]));
  originals.set('machine-metadata.json', carrier);
  try {
    await mkdir(product);
    for (const [name, bytes] of originals) await writeFile(join(product, name), bytes);
    const full = {
      appVersion: version,
      gitSha,
      archive: 'full.zip',
      archiveSha256: hash(originals.get('full.zip')),
    };
    const core = {
      appVersion: version,
      gitSha,
      resourceMode: 'core',
      archive: 'core.zip',
      archiveSha256: 'c'.repeat(64),
      contentDigest: 'd'.repeat(64),
      derivedFrom: { archiveSha256: full.archiveSha256 },
    };
    for (const [name, value] of [
      ['release-manifest.json', full],
      ['distribution-manifest.json', { appVersion: version, gitSha, archive: 'FullSetup.exe' }],
      ['core-release-manifest.json', core],
      [
        'core-distribution-manifest.json',
        {
          appVersion: version,
          gitSha,
          archive: 'CoreSetup.exe',
          contentDigest: core.contentDigest,
          originalArchiveSha256: core.archiveSha256,
        },
      ],
      [
        'web-installer-build.json',
        {
          artifact: web,
          gitSha,
          version,
          sha256: hash(originals.get(web)),
          bytes: originals.get(web).length,
          core: core.archive,
          installer: 'CoreSetup.exe',
        },
      ],
    ])
      await writeFile(join(product, name), JSON.stringify(value));
    const identity = { tag: 'v1.2.0', gitSha };
    const release = {
      id: 42,
      tag_name: identity.tag,
      draft: false,
      prerelease: false,
      published_at: publication.publishedAt,
      assets: [...originals].map(([name, bytes]) => ({
        name,
        size: bytes.length,
        digest: `sha256:${hash(bytes)}`,
        browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v1.2.0/${name}`,
      })),
    };
    await writeFile(join(root, 'promotion-identity.json'), JSON.stringify(identity));
    await writeFile(join(root, 'release.json'), JSON.stringify(release));
    await writeFile(
      join(root, 'ref.json'),
      JSON.stringify({ object: { type: 'commit', sha: gitSha } }),
    );
    const calls = join(root, 'gh-calls.jsonl');
    const hook = join(root, 'transport-fixture.mjs');
    // External gh transport is a fixture; this proves CLI lifecycle and retained
    // verifier calls, not signatures. Real published dual signatures are checked separately.
    await writeFile(
      hook,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
child.execFileSync = (command, args) => {
  if (command !== 'gh') throw Error('Unexpected external command');
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
  if (args[0] === 'release' && args[1] === 'download') copyFileSync(${JSON.stringify(join(product, 'machine-metadata.json'))}, join(args[args.indexOf('--dir')+1], 'machine-metadata.json'));
  else if (args[0] !== 'attestation' || args[1] !== 'verify') throw Error('Unexpected gh mutation');
  return Buffer.alloc(0);
};
syncBuiltinESMExports();`,
    );
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        hook,
        resolve('scripts/qualification/update-publication.mjs'),
        'verify-existing',
        'release.json',
        'ref.json',
        identity.tag,
        product,
      ],
      { cwd: root, encoding: 'utf8', timeout: 10000 },
    );
    expect(stdout).toContain('完整必需资产与正式发布确认一致');
    const operations = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(operations.map((args) => args.slice(0, 2))).toEqual([
      ['release', 'download'],
      ['attestation', 'verify'],
      ['attestation', 'verify'],
    ]);
    expect(operations.slice(1).map((args) => args[args.indexOf('--source-digest') + 1])).toEqual([
      gitSha,
      promotionSha,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
