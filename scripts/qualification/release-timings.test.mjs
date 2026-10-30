import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.throws(
    () => assertBoxTiming({ recovery: false, triggerToBoxMs: 600001 }, 'success'),
    /600-second budget/,
  );
  assert.doesNotThrow(() => assertBoxTiming({ recovery: true, triggerToBoxMs: 600001 }, 'success'));
  assert.throws(
    () => assertBoxTiming({ recovery: true, triggerToBoxMs: 600001 }, 'success', true),
    /600-second budget/,
  );
});
