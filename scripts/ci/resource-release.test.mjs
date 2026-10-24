import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import {
  prepareResourceCandidate,
  makeResourceDescriptor,
  readResourceCandidate,
  verifyQualifiedResources,
  verifyPublishedResources,
  freezePublishedResources,
  restorePublishedResourceMetadata,
} from './resource-release.mjs';
import { RESOURCE_ASSET_NAMES } from '../../packages/resource-pack-contract/catalog.mjs';

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
let directory, folder, candidate;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizar-resource-wiring-test-'));
  folder = join(directory, 'candidate');
  const result = await prepareResourceCandidate(root, folder, manifest, '1.0.0', 7);
  expect(result.trusted).toBe(false);
  await writeFile(join(directory, 'core.json'), JSON.stringify(manifest));
  candidate = await readResourceCandidate(folder, manifest);
}, 30000);
afterAll(async () => rm(directory, { recursive: true, force: true }));

describe('Release resource integration with the real official Pack', () => {
  it('keeps original reused publication bytes when restoring an existing carrier', async () => {
    const recovery = join(directory, 'carrier-recovery');
    await mkdir(recovery);
    const originals = new Map(
      Object.values(RESOURCE_ASSET_NAMES).map((name) => [name, Buffer.from(name)]),
    );
    for (const key of [
      'descriptor',
      'descriptorQualification',
      'archiveQualification',
      'publication',
      'publicationPromotion',
    ]) {
      const name = RESOURCE_ASSET_NAMES[key];
      await writeFile(join(recovery, name), originals.get(name));
    }
    await restorePublishedResourceMetadata(recovery, originals);
    await restorePublishedResourceMetadata(recovery, originals);
    for (const [name, bytes] of originals)
      expect(await readFile(join(recovery, name))).toEqual(bytes);
    const original = originals.get(RESOURCE_ASSET_NAMES.publication);
    await writeFile(join(recovery, RESOURCE_ASSET_NAMES.publication), 'different');
    await expect(restorePublishedResourceMetadata(recovery, originals)).rejects.toThrow();
    expect(await readFile(join(recovery, RESOURCE_ASSET_NAMES.publication), 'utf8')).toBe(
      'different',
    );
    expect(original).not.toEqual(Buffer.from('different'));
  });
  it('binds all 43 actual materials, canonical bytes, exact Core identity and fixed public addresses', () => {
    expect(candidate.pack.manifest.files).toHaveLength(43);
    // Includes the updated third-party notices shipped in this exact Pack.
    expect(candidate.pack.manifest.totalBytes).toBe(85665267);
    expect(candidate.entry.policy).toEqual({
      packVersion: '1.0.0',
      sourceSha,
      coreVersion: '1.1.0',
      minimumSequence: 7,
    });
    expect(Object.keys(candidate.entry.assets)).toHaveLength(8);
    expect(candidate.entry.assets['resource-catalog.json']).toBe(
      'https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/resource-catalog.json',
    );
  });
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
});

// Reuse the actual Pack bytes; prerelease suffixes affect Core identity, not Pack versions.
it.each(['alpha.1', 'beta.2', 'rc.3'])(
  'preserves exact %s Core identity and resource compatibility',
  async (suffix) => {
    const appVersion = `1.5.0-${suffix}`;
    const core = { ...manifest, appVersion, archive: `Mizar-v${appVersion}-Windows-x64-Core.zip` };
    const descriptor = makeResourceDescriptor(candidate.pack, core, candidate.entry.publication);
    const target = join(directory, suffix);
    await mkdir(target);
    await writeFile(
      join(target, 'resource-descriptor.json'),
      JSON.stringify(descriptor, null, 2) + '\n',
    );
    await writeFile(join(target, candidate.entry.archive.name), candidate.archiveBytes);
    const result = await readResourceCandidate(target, core);
    expect(result.entry.policy.coreVersion).toBe('1.5.0');
    expect(result.entry.policy.packVersion).toBe('1.0.0');
    expect(result.entry.assets['resource-catalog.json']).toContain(`/v${appVersion}/`);
    await expect(readResourceCandidate(target, { ...core, appVersion: '1.5.0' })).rejects.toThrow();
    await expect(
      readResourceCandidate(target, { ...core, gitSha: 'f'.repeat(40) }),
    ).rejects.toThrow();
    // The existing Pack explicitly excludes Core 2.0.0; suffix removal must not bypass that bound.
    expect(() =>
      makeResourceDescriptor(
        candidate.pack,
        {
          ...core,
          appVersion: `2.0.0-${suffix}`,
          archive: `Mizar-v2.0.0-${suffix}-Windows-x64-Core.zip`,
        },
        candidate.entry.publication,
      ),
    ).toThrow('兼容');
  },
);
