import { expect, it } from 'vitest';
import { releaseTimingReport } from './release-timings.mjs';

const run = (id, path, created_at, updated_at) => ({
  id,
  path,
  created_at,
  updated_at,
  conclusion: 'success',
  head_branch: 'main',
  head_sha: 'a'.repeat(40),
  event: path === '.github/workflows/box-sync.yml' ? 'workflow_run' : 'workflow_dispatch',
  run_attempt: 1,
});
const fixture = () => ({
  qualification: run(
    1,
    '.github/workflows/release-qualification.yml',
    '2026-10-10T00:00:00Z',
    '2026-10-10T00:04:00Z',
  ),
  promotion: run(
    2,
    '.github/workflows/release-promotion.yml',
    '2026-10-10T00:05:00Z',
    '2026-10-10T00:06:00Z',
  ),
  box: run(3, '.github/workflows/box-sync.yml', '2026-10-10T00:07:00Z', '2026-10-10T00:08:00Z'),
  jobs: {
    qualification: [
      { name: 'build', started_at: '2026-10-10T00:00:20Z', completed_at: '2026-10-10T00:04:00Z' },
    ],
    promotion: [
      { name: 'promote', started_at: '2026-10-10T00:05:10Z', completed_at: '2026-10-10T00:06:00Z' },
    ],
    box: [
      { name: 'sync', started_at: '2026-10-10T00:07:15Z', completed_at: '2026-10-10T00:08:00Z' },
    ],
  },
  finishedAt: '2026-10-10T00:08:00Z',
  publishedAt: '2026-10-10T00:05:30Z',
  tag: 'v1.2.1',
  sourceSha: 'a'.repeat(40),
  recovery: false,
  build: { cargoCache: { target: 'false', registry: 'true', resourceReused: 'false' }, phases: [] },
});

it('counts qualification, handoffs and runner queues in the complete release budget', () => {
  const report = releaseTimingReport(fixture());
  expect(report.triggerToBoxMs).toBe(480000);
  expect(report.promotionToBoxMs).toBe(180000);
  expect(report.publishedToBoxMs).toBe(150000);
  expect(report.qualification.initialQueueMs).toBe(20000);
  expect(report.promotion.initialQueueMs).toBe(10000);
  expect(report.box.initialQueueMs).toBe(15000);
  expect(report.freshReleaseWithin600Seconds).toBe(true);
  expect(
    releaseTimingReport({
      ...fixture(),
      qualification: { ...fixture().qualification, run_attempt: 2 },
    }).freshReleaseWithin600Seconds,
  ).toBe(false);
  expect(report.build.cargoCache).toEqual({
    target: 'false',
    registry: 'true',
    resourceReused: 'false',
  });
  expect(releaseTimingReport({ ...fixture(), recovery: true }).freshReleaseWithin600Seconds).toBe(
    false,
  );
  expect(
    releaseTimingReport({ ...fixture(), publishedAt: '2026-10-10T00:04:30Z' })
      .freshReleaseWithin600Seconds,
  ).toBe(false);
  expect(
    releaseTimingReport({ ...fixture(), finishedAt: '2026-10-10T00:11:00Z' })
      .freshReleaseWithin600Seconds,
  ).toBe(false);
});

it('rejects mixed or failed source evidence and invalid clocks', () => {
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { conclusion: 'failure' },
    { head_branch: 'feature' },
    { path: '.github/workflows/ci.yml' },
  ])
    expect(() =>
      releaseTimingReport({
        ...fixture(),
        qualification: { ...fixture().qualification, ...patch },
      }),
    ).toThrow();
  expect(() =>
    releaseTimingReport({
      ...fixture(),
      promotion: { ...fixture().promotion, conclusion: 'failure' },
    }),
  ).toThrow();
  for (const patch of [
    { path: '.github/workflows/ci.yml' },
    { event: 'workflow_dispatch' },
    { head_branch: 'feature' },
    { created_at: '2026-10-10T00:05:00Z' },
  ])
    expect(() =>
      releaseTimingReport({ ...fixture(), box: { ...fixture().box, ...patch } }),
    ).toThrow();
  expect(() =>
    releaseTimingReport({
      ...fixture(),
      promotion: { ...fixture().promotion, created_at: '2026-10-10T00:03:00Z' },
    }),
  ).toThrow();
  for (const finishedAt of ['invalid', '2026-10-09T23:59:59Z'])
    expect(() => releaseTimingReport({ ...fixture(), finishedAt })).toThrow();
});
