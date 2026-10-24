import { expect, it } from 'vitest';
import { releaseTimingReport } from './release-timings.mjs';

const at = (time) => `2026-10-24T${time}Z`;
const oldJob = { name: 'build', started_at: at('00:00:03'), completed_at: at('00:02:00') };
function report(currentJobs) {
  return releaseTimingReport({
    qualification: {
      id: 1,
      path: '.github/workflows/release-qualification.yml',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: 'qualified-source',
      event: 'workflow_dispatch',
      run_attempt: 2,
      created_at: at('00:00:00'),
      run_started_at: at('00:10:00'),
      updated_at: at('00:12:00'),
    },
    promotion: {
      id: 2,
      path: '.github/workflows/release-promotion.yml',
      head_branch: 'main',
      event: 'workflow_dispatch',
      run_attempt: 1,
      created_at: at('00:13:00'),
      run_started_at: at('00:13:00'),
    },
    jobs: {
      qualification: currentJobs,
      qualificationFirstAttempt: [oldJob],
      promotion: [{ name: 'promote', started_at: at('00:13:02') }],
    },
    tag: 'v1.6.3',
    sourceSha: 'qualified-source',
    publishedAt: at('00:13:30'),
    finishedAt: at('00:14:00'),
    recovery: false,
  });
}

it('keeps inherited successful jobs while measuring retry queue from the new attempt', () => {
  const result = report([
    oldJob,
    { name: 'setup', started_at: at('00:10:03'), completed_at: at('00:11:00') },
  ]);
  expect(result.recovery).toBe(true);
  expect(result.qualification).toMatchObject({
    durationMs: 720000,
    initialQueueMs: 3000,
    attemptQueueMs: 3000,
  });
  expect(result.qualification.jobs).toHaveLength(2);
});

it('leaves retry queue unknown when only inherited jobs are available', () => {
  const result = report([oldJob]);
  expect(result.qualification.attemptQueueMs).toBeNull();
  expect(result.qualification.durationMs).toBe(720000);
  expect(result.qualification.initialQueueMs).toBe(3000);
});
