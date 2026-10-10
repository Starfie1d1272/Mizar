import { Buffer } from 'node:buffer';
import { jsonBytes } from '../../packages/resource-pack-contract/content.mjs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import {
  prepareResourceCandidate,
  makeResourceDescriptor,
  readResourceCandidate,
  makePublishedCatalog,
  verifyQualifiedResources,
  verifyPublishedResources,
  freezePublishedResources,
  publishedResourceMetadata,
  restorePublishedResourceBindings,
} from './resource-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
// Structural Core fixture only. It is deliberately unsigned and cannot be promoted.
const manifest = {
  appVersion: '1.1.0',
  gitSha: sourceSha,
  archive: 'Mizar-v1.1.0-Windows-x64.zip',
  archiveSha256: 'a'.repeat(64),
  desktopBuildProfile: 'release',
  developmentOnly: false,
};
let directory, folder, descriptorBytes, candidate;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizar-resource-wiring-test-'));
  folder = join(directory, 'candidate');
  const result = await prepareResourceCandidate(root, folder, manifest, '1.0.0', 7);
  expect(result.trusted).toBe(false);
  await writeFile(join(directory, 'core.json'), JSON.stringify(manifest));
  descriptorBytes = await readFile(join(folder, 'resource-descriptor.json'));
  candidate = await readResourceCandidate(folder, manifest);
}, 30000);
afterAll(async () => rm(directory, { recursive: true, force: true }));

describe('Release resource integration with the real official Pack', () => {
  it('binds all 43 actual materials, canonical bytes, exact Core identity and fixed public addresses', () => {
    expect(candidate.pack.manifest.files).toHaveLength(43);
    expect(candidate.pack.manifest.totalBytes).toBe(85680266);
    expect(candidate.entry.policy).toEqual({
      packVersion: '1.0.0',
      sourceSha,
      coreVersion: '1.1.0',
      minimumSequence: 7,
    });
    expect(Object.keys(candidate.entry.assets)).toHaveLength(8);
    expect(candidate.entry.assets['resource-catalog.json']).toBe(
      'https://github.com/Starfie1d1272/Mizar/releases/download/data-v1.1.0/resource-catalog.json',
    );
  });
  it('still reads canonical historical v descriptors without changing their bytes', async () => {
    const legacy = makeResourceDescriptor(candidate.pack, manifest, candidate.entry.publication);
    const bytes = jsonBytes(legacy);
    await writeFile(join(folder, 'resource-descriptor.json'), bytes);
    try {
      const historical = await readResourceCandidate(folder, manifest);
      expect(historical.bytes).toEqual(bytes);
      expect(historical.entry.assets['resource-catalog.json']).toBe(
        'https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/resource-catalog.json',
      );
      const asset = {
        name: 'resource-descriptor.json',
        size: bytes.length,
        sha256: 'c'.repeat(64),
      };
      const release = {
        tag_name: 'v1.1.0',
        draft: false,
        prerelease: false,
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          {
            name: asset.name,
            size: asset.size,
            digest: `sha256:${asset.sha256}`,
            browser_download_url: historical.entry.assets[asset.name],
          },
        ],
      };
      expect(() => publishedResourceMetadata(release, legacy, [asset])).not.toThrow();
      expect(() =>
        publishedResourceMetadata({ ...release, draft: true }, legacy, [asset]),
      ).toThrow();
    } finally {
      await writeFile(join(folder, 'resource-descriptor.json'), descriptorBytes);
    }
  });
  it('allows a later main promoter without relabeling the original qualified resource source', () => {
    const catalog = makePublishedCatalog(candidate, 'b'.repeat(40));
    expect(catalog.promotionSha).toBe('b'.repeat(40));
    expect(catalog.resources[0].policy.sourceSha).toBe(sourceSha);
    expect(catalog.resources[0].policy.promotionSha).toBe('b'.repeat(40));
    expect(catalog.descriptorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.resources[0].publication.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('restores exact original Promotion subjects from either surviving subject or proof identity', () => {
    const promotionSha = 'b'.repeat(40);
    const catalog = makePublishedCatalog(candidate, promotionSha);
    const catalogBytes = jsonBytes(catalog);
    const files = new Map([['resource-catalog.json', catalogBytes]]);
    expect(restorePublishedResourceBindings(candidate, files)).toBe(promotionSha);
    expect(files.get('resource-catalog.json')).toEqual(catalogBytes);
    const publicationBytes = files.get('resource-publication.json');
    const fromPublication = new Map([['resource-publication.json', publicationBytes]]);
    expect(restorePublishedResourceBindings(candidate, fromPublication)).toBe(promotionSha);
    expect(fromPublication.get('resource-catalog.json')).toEqual(catalogBytes);
    const proof = jsonBytes({
      dsseEnvelope: {
        payload: Buffer.from(
          JSON.stringify({
            predicate: {
              buildDefinition: {
                resolvedDependencies: [
                  {
                    uri: 'git+https://github.com/Starfie1d1272/Mizar@refs/heads/main',
                    digest: { gitCommit: promotionSha },
                  },
                ],
              },
            },
          }),
        ).toString('base64'),
      },
    });
    const fromProof = new Map([['resource-catalog-promotion-provenance.json', proof]]);
    expect(restorePublishedResourceBindings(candidate, fromProof)).toBe(promotionSha);
    expect(fromProof.get('resource-catalog.json')).toEqual(catalogBytes);
    expect(fromProof.get('resource-publication.json')).toEqual(publicationBytes);
    // This derives untrusted bindings only; installation still requires real proofs.
    expect(restorePublishedResourceBindings(candidate, new Map())).toBeNull();
    const changed = new Map([['resource-catalog.json', Buffer.from('{}')]]);
    expect(() => restorePublishedResourceBindings(candidate, changed)).toThrow();
    const mixed = new Map([
      ['resource-catalog.json', catalogBytes],
      ['resource-publication.json', jsonBytes({ promotionSha: 'd'.repeat(40) })],
    ]);
    expect(() => restorePublishedResourceBindings(candidate, mixed)).toThrow('晋级身份');
  });
  it('checks present assets on a partial data Release and rejects changed metadata', () => {
    const expected = [
      { name: 'resource-descriptor.json', size: descriptorBytes.length, sha256: 'c'.repeat(64) },
    ];
    const asset = {
      name: expected[0].name,
      size: expected[0].size,
      digest: `sha256:${expected[0].sha256}`,
      browser_download_url: candidate.entry.assets[expected[0].name],
    };
    const release = {
      tag_name: 'data-v1.1.0',
      draft: false,
      prerelease: true,
      published_at: '2026-01-01T00:00:00Z',
      assets: [asset],
    };
    expect(() => publishedResourceMetadata(release, candidate.descriptor, expected)).not.toThrow();
    expect(() =>
      publishedResourceMetadata(
        { ...release, draft: true, published_at: null },
        candidate.descriptor,
        expected,
        true,
        true,
      ),
    ).not.toThrow();
    expect(() =>
      publishedResourceMetadata({ ...release, assets: [] }, candidate.descriptor, expected, true),
    ).not.toThrow();
    expect(() =>
      publishedResourceMetadata({ ...release, assets: [] }, candidate.descriptor, expected),
    ).toThrow('缺失');
    for (const changed of [
      { ...release, prerelease: false },
      { ...release, tag_name: 'v1.1.0' },
      { ...release, draft: true },
      { ...release, assets: [{ ...asset, digest: `sha256:${'d'.repeat(64)}` }] },
      { ...release, assets: [asset, asset] },
    ])
      expect(() =>
        publishedResourceMetadata(changed, candidate.descriptor, expected, true),
      ).toThrow();
  });
  it.each([
    ['developmentOnly', true],
    ['desktopBuildProfile', 'ci'],
    ['gitSha', 'c'.repeat(40)],
    ['archiveSha256', 'd'.repeat(64)],
    ['appVersion', '1.2.0'],
  ])('rejects changed or nonproduction Core field %s', async (key, value) => {
    await expect(readResourceCandidate(folder, { ...manifest, [key]: value })).rejects.toThrow();
  });
  it('rejects mirror URL changes, rollback policy, extra fields and duplicate JSON fields', async () => {
    try {
      for (const edit of [
        (d) => {
          d.resources[0].assets['resource-catalog.json'] = 'https://evil.invalid/catalog';
        },
        (d) => {
          d.resources[0].policy.minimumSequence = 1;
        },
        (d) => {
          d.trusted = true;
        },
      ]) {
        const descriptor = JSON.parse(descriptorBytes);
        edit(descriptor);
        await writeFile(join(folder, 'resource-descriptor.json'), JSON.stringify(descriptor));
        await expect(readResourceCandidate(folder, manifest)).rejects.toThrow();
      }
      await writeFile(
        join(folder, 'resource-descriptor.json'),
        descriptorBytes
          .toString()
          .replace('"repository":', '"repository":"evil/Mizar","repository":'),
      );
      await expect(readResourceCandidate(folder, manifest)).rejects.toThrow(/规范字节/);
    } finally {
      await writeFile(join(folder, 'resource-descriptor.json'), descriptorBytes);
    }
  }, 30000);
  it('rejects undeclared files before the qualification wildcard signer can see them', async () => {
    const extra = join(folder, 'unsigned-extra.zip');
    await writeFile(extra, 'untrusted');
    try {
      expect(() =>
        execFileSync(
          'node',
          [
            join(root, 'scripts/ci/resource-release.mjs'),
            'check',
            folder,
            join(directory, 'core.json'),
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      await rm(extra);
    }
  });
  it('cannot turn missing or fake proofs into a qualified/published/frozen result', async () => {
    await expect(verifyQualifiedResources(folder, manifest)).rejects.toThrow();
    await writeFile(join(folder, 'resource-pack-provenance.json'), '{}');
    await writeFile(join(folder, 'resource-descriptor-qualification-provenance.json'), '{}');
    execFileSync('gh', ['attestation', 'verify', '--help'], { stdio: 'pipe' });
    await expect(verifyQualifiedResources(folder, manifest)).rejects.toThrow();
    await expect(verifyPublishedResources(folder, manifest)).rejects.toThrow();
    const output = join(directory, 'published');
    await expect(freezePublishedResources(folder, manifest, output)).rejects.toThrow();
    await expect(readFile(join(output, 'resource-publication.json'))).rejects.toThrow();
  }, 30000);
  it('refuses symlinked transfer metadata', async () => {
    const linked = join(directory, 'linked');
    await mkdir(linked);
    await symlink(
      join(folder, 'resource-descriptor.json'),
      join(linked, 'resource-descriptor.json'),
    );
    await expect(readResourceCandidate(linked, manifest)).rejects.toThrow(/输入文件类型/);
  });
});
