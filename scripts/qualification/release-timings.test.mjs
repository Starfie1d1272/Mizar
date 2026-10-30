import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { assertBoxTiming, releaseTimingReport } from './release-timings.mjs';

test('failed Box remains a failure and recovery cannot pass first-release budget', () => {
  const sha = 'a'.repeat(40);
  const qualification = {
    id: 1,
    path: '.github/workflows/release-qualification.yml',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: sha,
    event: 'workflow_dispatch',
    run_attempt: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
  };
  const promotion = {
    id: 2,
    path: '.github/workflows/release-promotion.yml',
    conclusion: 'success',
    head_branch: 'main',
    event: 'workflow_run',
    run_attempt: 1,
    created_at: '2026-01-01T00:01:01Z',
    updated_at: '2026-01-01T00:02:00Z',
  };
  const box = {
    id: 3,
    path: '.github/workflows/box-sync.yml',
    head_branch: 'main',
    event: 'workflow_run',
    run_attempt: 1,
    created_at: '2026-01-01T00:02:01Z',
  };
  const report = releaseTimingReport({
    qualification,
    promotion,
    box,
    jobs: { qualification: [], promotion: [], box: [] },
    finishedAt: '2026-01-01T00:05:00Z',
    publishedAt: '2026-01-01T00:01:30Z',
    sourceSha: sha,
    recovery: false,
    boxOutcome: 'failure',
    boxRecoveryStartedAt: '2026-01-01T00:03:00Z',
  });
  assert.equal(report.recovery, true);
  assert.equal(report.boxOutcome, 'failure');
  assert.equal(report.boxRecoveryDurationMs, 120000);
  assert.equal(report.freshReleaseWithin600Seconds, false);
  assert.throws(() => assertBoxTiming(report, 'failure'), /Box synchronization failed/);
  const slowSuccess = releaseTimingReport({
    qualification,
    promotion,
    box,
    jobs: { qualification: [], promotion: [], box: [] },
    finishedAt: '2026-01-01T00:10:01Z',
    publishedAt: '2026-01-01T00:01:30Z',
    sourceSha: sha,
    recovery: false,
    boxOutcome: 'success',
  });
  assert.equal(slowSuccess.triggerToBoxMs, 601000);
  assert.equal(slowSuccess.triggerToPublicationMs, 90000);
  assert.equal(slowSuccess.freshGitHubPublicWithin600Seconds, true);
  assert.equal(slowSuccess.freshReleaseWithin600Seconds, false);
  assert.doesNotThrow(() => assertBoxTiming(slowSuccess, 'success'));
  assert.doesNotThrow(() => assertBoxTiming({ recovery: true, triggerToBoxMs: 600001 }, 'success'));
});

test('missing timing evidence does not fail a successful Box, but failed Box remains failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-timing-test-'));
  const output = join(directory, 'timing.json');
  const run = promisify(execFile);
  const script = fileURLToPath(new URL('./release-timings.mjs', import.meta.url));
  const env = {
    ...process.env,
    PATH: directory,
    GITHUB_STEP_SUMMARY: '',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_RUN_ID: '1',
    BOX_OUTCOME: 'success',
  };
  try {
    await run(process.execPath, [script, 'box', output], {
      env,
    });
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.measurementUnavailable, true);
    assert.equal(report.freshReleaseWithin600Seconds, false);
    await assert.rejects(
      run(process.execPath, [script, 'box', output], {
        env: { ...env, BOX_OUTCOME: 'failure' },
      }),
      /Box synchronization failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
