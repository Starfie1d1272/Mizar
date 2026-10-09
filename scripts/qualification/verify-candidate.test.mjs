import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCandidate } from './verify-candidate.mjs';
import { createBuildTimer } from './build-timings.mjs';
import {
  assertQualificationIdentity,
  assertQualificationRun,
  releaseAttestationArgs,
} from './release-identity.mjs';

const signingSha = 'a'.repeat(40);
const signingContext = {
  repository: 'Starfie1d1272/Mizar',
  ref: 'refs/heads/main',
  sha: signingSha,
  event: 'workflow_dispatch',
  workflowRef: 'Starfie1d1272/Mizar/.github/workflows/release-qualification.yml@refs/heads/main',
};

it('binds the candidate, checkout and main signing context before build and attestation', () => {
  expect(assertQualificationIdentity(signingContext, signingSha, signingSha, signingSha)).toBe(
    signingSha,
  );
  for (const patch of [
    { ref: 'refs/heads/feature' },
    { event: 'pull_request' },
    { repository: 'other/Mizar' },
    { workflowRef: signingContext.workflowRef.replace('main', 'feature') },
    { sha: 'main' },
  ]) {
    expect(() =>
      assertQualificationIdentity({ ...signingContext, ...patch }, signingSha, signingSha),
    ).toThrow();
  }
  for (const [checkout, requested, manifest] of [
    ['b'.repeat(40), signingSha, signingSha],
    [signingSha, 'b'.repeat(40), signingSha],
    [signingSha, signingSha, 'b'.repeat(40)],
    [signingSha, 'main', signingSha],
  ]) {
    expect(() =>
      assertQualificationIdentity(signingContext, checkout, requested, manifest),
    ).toThrow();
  }
});

it('rejects old or differently signed qualification evidence at promotion', () => {
  const run = {
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/release-qualification.yml',
    head_branch: 'main',
    head_repository: { full_name: 'Starfie1d1272/Mizar' },
    head_sha: signingSha,
  };
  expect(() => assertQualificationRun(run, signingSha)).not.toThrow();
  for (const patch of [
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { event: 'push' },
    { path: '.github/workflows/other.yml' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'other/Mizar' } },
    { head_sha: 'b'.repeat(40) },
  ]) {
    expect(() => assertQualificationRun({ ...run, ...patch }, signingSha)).toThrow();
  }
  expect(() => assertQualificationRun(run, 'b'.repeat(40))).toThrow();
  expect(() => releaseAttestationArgs('asset.exe', 'main')).toThrow();
});

it('rejects changed transfers, mixed lane evidence and substituted Setup assets', async () => {
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
    for (const lane of ['portable', 'setup']) {
      await mkdir(join(root, lane));
      await writeIdentity(lane, { ...manifest, ...(lane === 'setup' ? { distribution } : {}) });
    }
    await writeFile(join(root, 'distribution-manifest.json'), JSON.stringify(distribution));
    expect(await verifyCandidate(root, sha, digest, root)).toEqual(manifest);
    await writeIdentity('portable', { ...manifest, gitSha: 'd'.repeat(40) });
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('portable 验收身份');
    await writeIdentity('portable', manifest);
    await writeIdentity('setup', { ...manifest, distribution: { archiveSha256: 'd'.repeat(64) } });
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('Setup 验收身份');
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
