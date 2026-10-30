import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildTimer } from './build-timings.mjs';
import { preserveBuildTiming } from './build-timing-evidence.mjs';

test('concurrent phase completions preserve every timing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-timings-'));
  try {
    const timed = createBuildTimer(directory, { gitSha: 'test' });
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => timed(`phase-${index}`, async () => {})),
    );
    const result = JSON.parse(await readFile(join(directory, 'build-timings.json'), 'utf8'));
    assert.equal(result.phases.length, 30);
    assert.equal(new Set(result.phases.map(({ phase }) => phase)).size, 30);
    assert.ok(result.phases.every(({ status }) => status === 'success'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unwritable timing evidence does not mask build success or failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-timing-missing-'));
  try {
    const timed = createBuildTimer(join(directory, 'missing'), { gitSha: 'test' });
    assert.equal(await timed('success', async () => 42), 42);
    await assert.rejects(
      timed('failure', async () => {
        throw new Error('build failed');
      }),
      /build failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing, malformed or unrelated build timing is recorded as unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-timing-evidence-'));
  const source = join(dir, 'source.json'),
    destination = join(dir, 'evidence.json');
  const sha = 'a'.repeat(40);
  try {
    for (const value of [
      null,
      'invalid json',
      '{}',
      JSON.stringify({ gitSha: 'b'.repeat(40), desktopBuildProfile: 'release', phases: [] }),
      JSON.stringify({ gitSha: sha, desktopBuildProfile: 'release', phases: [] }),
    ]) {
      if (value !== null) await writeFile(source, value);
      const result = await preserveBuildTiming(source, destination, sha);
      assert.deepEqual(result, { measurementUnavailable: true });
      assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), result);
    }
    const good = {
      gitSha: sha,
      desktopBuildProfile: 'release',
      phases: [
        'workspace-build',
        'deploy-production-dependencies',
        'node-runtime',
        'observer-component',
        'mulnx-bundle',
        'desktop-cargo-build',
        'content-digest',
        'payload-checksums',
        'zip-archive',
      ].map((phase) => ({ phase, durationMs: 1, status: 'success' })),
    };
    await writeFile(source, JSON.stringify(good));
    assert.deepEqual(await preserveBuildTiming(source, destination, sha), good);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
