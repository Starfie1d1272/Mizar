import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCandidate } from './verify-candidate.mjs';
import { createBuildTimer } from './build-timings.mjs';

it('rejects changed transfers, mixed lane evidence and substituted SFX assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-candidate-'));
  const sha = 'a'.repeat(40);
  const digest = createHash('sha256').update('candidate ZIP').digest('hex');
  const manifest = {
    gitSha: sha,
    archive: 'Mizar-v1.0.0-rc.1-Windows-x64.zip',
    appVersion: '1.0.0-rc.1',
    archiveSha256: digest,
    contentDigest: 'b'.repeat(64),
    desktopBuildProfile: 'release',
    developmentOnly: false,
  };
  const distribution = { archiveSha256: 'c'.repeat(64) };
  const writeManifest = (value) =>
    writeFile(join(root, 'release-manifest.json'), JSON.stringify(value));
  const writeIdentity = (lane, value) =>
    writeFile(join(root, lane, `${lane}-identity.json`), JSON.stringify(value));
  try {
    await writeManifest(manifest);
    await writeFile(join(root, manifest.archive), 'candidate ZIP');
    expect(await verifyCandidate(root, sha, digest)).toEqual(manifest);
    await expect(verifyCandidate(root, 'd'.repeat(40), digest)).rejects.toThrow('身份');
    await expect(verifyCandidate(root, sha, 'd'.repeat(64))).rejects.toThrow('身份');
    await writeFile(join(root, manifest.archive), 'tampered ZIP');
    await expect(verifyCandidate(root, sha, digest)).rejects.toThrow('传输摘要');
    await writeFile(join(root, manifest.archive), 'candidate ZIP');
    await writeManifest({ ...manifest, archive: '../other.zip' });
    await expect(verifyCandidate(root, sha, digest)).rejects.toThrow('身份');
    await writeManifest(manifest);
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow();
    for (const lane of ['portable', 'sfx']) {
      await mkdir(join(root, lane));
      await writeIdentity(lane, { ...manifest, ...(lane === 'sfx' ? { distribution } : {}) });
    }
    await writeFile(join(root, 'distribution-manifest.json'), JSON.stringify(distribution));
    expect(await verifyCandidate(root, sha, digest, root)).toEqual(manifest);
    await writeIdentity('portable', { ...manifest, gitSha: 'd'.repeat(40) });
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('portable 验收身份');
    await writeIdentity('portable', manifest);
    await writeIdentity('sfx', { ...manifest, distribution: { archiveSha256: 'd'.repeat(64) } });
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('SFX 验收身份');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('records successful and failed build phases while preserving the build error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-timings-'));
  try {
    const timed = createBuildTimer(root, { gitSha: 'a'.repeat(40) });
    expect(await timed('build', async () => 42)).toBe(42);
    await expect(
      timed('archive', async () => {
        throw new Error('archive failed');
      }),
    ).rejects.toThrow('archive failed');
    const report = JSON.parse(await readFile(join(root, 'build-timings.json'), 'utf8'));
    expect(report.phases).toEqual([
      { phase: 'build', status: 'success', durationMs: expect.any(Number) },
      { phase: 'archive', status: 'failure', durationMs: expect.any(Number) },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
