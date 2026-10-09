import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import {
  prepareResourceCandidate,
  readResourceCandidate,
  makePublishedCatalog,
  verifyQualifiedResources,
  verifyPublishedResources,
  freezePublishedResources,
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
      'https://github.com/Starfie1d1272/Mizar/releases/download/v1.1.0/resource-catalog.json',
    );
  });
  it('allows a later main promoter without relabeling the original qualified resource source', () => {
    const catalog = makePublishedCatalog(candidate, 'b'.repeat(40));
    expect(catalog.promotionSha).toBe('b'.repeat(40));
    expect(catalog.resources[0].policy.sourceSha).toBe(sourceSha);
    expect(catalog.resources[0].policy.promotionSha).toBe('b'.repeat(40));
    expect(catalog.descriptorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.resources[0].publication.sha256).toMatch(/^[a-f0-9]{64}$/);
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
