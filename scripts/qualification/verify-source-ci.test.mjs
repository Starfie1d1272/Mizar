import { expect, it, vi } from 'vitest';
import { requiredJobs, verifySourceCi } from './verify-source-ci.mjs';

const repository = 'Starfie1d1272/Mizar';
const sha = 'a'.repeat(40);
const run = {
  id: 10,
  run_attempt: 2,
  head_sha: sha,
  head_repository: { full_name: repository },
  path: '.github/workflows/ci.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/Starfie1d1272/Mizar/actions/runs/10',
};
const jobs = requiredJobs.map((name) => ({ name, conclusion: 'success' }));
const apiFor = (runs = [run], jobList = jobs) =>
  vi.fn((endpoint) =>
    endpoint.includes('/jobs?')
      ? [{ jobs: jobList.slice(0, 8) }, { jobs: jobList.slice(8) }]
      : [{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }],
  );

it('uses the product SHA, paginates runs/jobs and records the exact CI attempt', () => {
  const api = apiFor([{ ...run, id: 11, event: 'pull_request' }, run]);
  expect(verifySourceCi(repository, sha, api)).toEqual({
    gitSha: sha,
    runId: 10,
    runAttempt: 2,
    url: run.html_url,
  });
  expect(api.mock.calls[0][0]).toContain(`head_sha=${sha}`);
  expect(api.mock.calls[1][0]).toContain('/runs/10/attempts/2/jobs?');
});

it.each([
  { head_sha: 'b'.repeat(40) },
  { head_repository: { full_name: 'fork/Mizar' } },
  { path: '.github/workflows/other.yml' },
  { event: 'pull_request' },
  { status: 'in_progress', conclusion: null },
  { conclusion: 'failure' },
  { conclusion: 'cancelled' },
])('rejects unavailable/untrusted/unsuccessful source CI: %j', (overrides) => {
  expect(() => verifySourceCi(repository, sha, apiFor([{ ...run, ...overrides }]))).toThrow(
    '最新 CI 未成功',
  );
});

it('does not fall back to an older success when a newer run fails', () => {
  expect(() =>
    verifySourceCi(repository, sha, apiFor([run, { ...run, id: 11, conclusion: 'failure' }])),
  ).toThrow('最新 CI 未成功');
});

it.each(['skipped', 'failure', 'cancelled', null])(
  'rejects an incomplete lane: %s',
  (conclusion) => {
    expect(() =>
      verifySourceCi(
        repository,
        sha,
        apiFor(
          [run],
          jobs.map((job, index) => (index === 1 ? { ...job, conclusion } : job)),
        ),
      ),
    ).toThrow('缺少完整 CI');
  },
);

it('rejects docs-only CI, missing matrix shards and ambiguous jobs', () => {
  for (const jobList of [
    jobs.filter((job) => job.name === 'ci-gate'),
    jobs.slice(1),
    [...jobs, jobs[0]],
  ]) {
    expect(() => verifySourceCi(repository, sha, apiFor([run], jobList))).toThrow('缺少完整 CI');
  }
  expect(() => verifySourceCi(repository, sha, apiFor([]))).toThrow('最新 CI 未成功');
});

it('fails closed on API errors and invalid SHA', () => {
  expect(() => verifySourceCi(repository, 'main', apiFor())).toThrow('无效');
  expect(() =>
    verifySourceCi(repository, sha, () => {
      throw new Error('API unavailable');
    }),
  ).toThrow('API unavailable');
});
