import { expect, it } from 'vitest';
import { ciTimingReport } from './measure-run.mjs';

it('separates the first runner queue, retry queue, gate and whole workflow wall time', () => {
  const run = {
    id: 1,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-10-11T00:00:00Z',
    run_started_at: '2026-10-11T00:04:00Z',
    updated_at: '2026-10-11T00:04:52Z',
  };
  const first = [{ started_at: '2026-10-11T00:00:03Z' }];
  const jobs = [
    {
      name: 'plan',
      started_at: '2026-10-11T00:04:05Z',
      completed_at: '2026-10-11T00:04:10Z',
      steps: [],
    },
    {
      name: 'ci-gate',
      started_at: '2026-10-11T00:04:40Z',
      completed_at: '2026-10-11T00:04:50Z',
      steps: [],
    },
  ];
  const report = ciTimingReport('owner/repo', run, jobs, first);
  expect(report.initialQueueSeconds).toBe(3);
  expect(report.attemptQueueSeconds).toBe(5);
  expect(report.gateWallSeconds).toBe(290);
  expect(report.wallSeconds).toBe(292);
  expect(ciTimingReport('owner/repo', run, jobs).initialQueueSeconds).toBeNull();
  expect(() => ciTimingReport('owner/repo', { ...run, status: 'in_progress' }, jobs)).toThrow(
    'terminal',
  );
});
