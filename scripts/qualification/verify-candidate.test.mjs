import { Buffer } from 'node:buffer';
import { expect, it, vi } from 'vitest';
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
  const core = {
    ...manifest,
    resourceMode: 'core',
    archive: 'Mizar-v1.0.0-rc.1-Windows-x64-Core.zip',
    archiveSha256: 'e'.repeat(64),
    derivedFrom: { archiveSha256: digest, contentDigest: manifest.contentDigest },
  };
  const coreDistribution = { archiveSha256: 'f'.repeat(64) };
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
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow();
    await mkdir(join(root, 'core-setup'));
    await writeFile(join(root, 'core-release-manifest.json'), JSON.stringify(core));
    await writeFile(
      join(root, 'core-distribution-manifest.json'),
      JSON.stringify(coreDistribution),
    );
    await writeIdentity('core-setup', { ...core, distribution: coreDistribution });
    for (const lane of ['setup', 'core-setup'])
      await writeFile(join(root, lane, 'update-recovery.log'), 'Native recovery passed');
    expect(await verifyCandidate(root, sha, digest, root)).toEqual(manifest);
    await writeIdentity('core-setup', {
      ...core,
      gitSha: 'd'.repeat(40),
      distribution: coreDistribution,
    });
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('core-setup 验收身份');
    await writeIdentity('core-setup', { ...core, distribution: { archiveSha256: 'd'.repeat(64) } });
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('Core Setup 验收身份');
    await writeIdentity('core-setup', { ...core, distribution: coreDistribution });
    await writeFile(join(root, 'core-setup/update-recovery.log'), '');
    await expect(verifyCandidate(root, sha, digest, root)).rejects.toThrow('缺少恢复');
    await writeFile(join(root, 'core-setup/update-recovery.log'), 'Native recovery passed');
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

// Only isolate checks already owned by payload/resource tests and ZIP creation;
// the failing Node filesystem operation runs unchanged on real directories.
it('partitions into a new Core directory and never overwrites a previous candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-core-partition-'));
  const name = 'Mizar-v1.2.0-Windows-x64';
  const artifact = {
    gitSha: signingSha,
    appVersion: '1.2.0',
    resourceMode: 'full',
    artifactSha256: 'b'.repeat(64),
    desktopBuildProfile: 'release',
  };
  const archive = Buffer.from('unsigned Full fixture');
  const manifest = {
    ...artifact,
    contentDigest: artifact.artifactSha256,
    archive: name + '.zip',
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    developmentOnly: false,
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    const original = join(root, name);
    for (const path of [
      'resources/metadata',
      'resources/web/dist/fixtures',
      'resources/web/dist/fixture-media',
    ])
      await mkdir(join(original, path), { recursive: true });
    await writeFile(join(original, 'resources/web/dist/index.html'), 'retained Core');
    await writeFile(join(original, 'resources/web/dist/fixtures/example'), 'optional replay');
    await writeFile(join(root, name + '.zip'), archive);
    await writeFile(join(root, 'release-manifest.json'), JSON.stringify(manifest));
    vi.doMock('./product-runtime.mjs', () => ({ verifyPayload: vi.fn(async () => artifact) }));
    vi.doMock('./verify-web-resources.mjs', () => ({ verifyWebResources: vi.fn(async () => {}) }));
    vi.doMock('./build.mjs', async () => {
      const actual = await vi.importActual('./build.mjs');
      return {
        ...actual,
        createArchive: async () => ({
          archivePath: join(root, name + '-Core.zip'),
          archiveSha256: 'c'.repeat(64),
        }),
      };
    });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { prepareCoreCandidate } = await import('./core-candidate.mjs');
    const core = await prepareCoreCandidate(root, signingContext, signingSha, signingSha);
    expect(core.resourceMode).toBe('core');
    expect(await readFile(join(root, name + '-Core/resources/web/dist/index.html'), 'utf8')).toBe(
      'retained Core',
    );
    await expect(
      readFile(join(root, name + '-Core/resources/web/dist/fixtures/example')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(original, 'resources/web/dist/fixtures/example'), 'utf8')).toBe(
      'optional replay',
    );
    expect(await readFile(join(root, manifest.archive))).toEqual(archive);
    const sentinel = join(root, name + '-Core/keep');
    await writeFile(sentinel, 'existing candidate');
    await expect(
      prepareCoreCandidate(root, signingContext, signingSha, signingSha),
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EEXIST' });
    expect(await readFile(sentinel, 'utf8')).toBe('existing candidate');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.doUnmock('./product-runtime.mjs');
    vi.doUnmock('./verify-web-resources.mjs');
    vi.doUnmock('./build.mjs');
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
});
