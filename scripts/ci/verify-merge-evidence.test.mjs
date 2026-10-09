import { expect, it } from 'vitest';
import { verifyMergeEvidence } from './verify-merge-evidence.mjs';
import { fullSourceJobs } from './source-contract.mjs';

const repository = 'Starfie1d1272/Mizar';
const sha = (char) => char.repeat(40);
const finalSha = sha('a'),
  base = sha('b'),
  head = sha('c'),
  mergeSha = sha('d'),
  treeSha = sha('e');
function fixture() {
  const run = {
    id: 20,
    run_attempt: 2,
    head_sha: head,
    event: 'pull_request',
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    path: '.github/workflows/ci.yml',
    workflow_id: 5,
    check_suite_id: 8,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/example/run/20',
  };
  const pr = {
    number: 3,
    merged_at: '2026-10-09T20:00:00Z',
    merge_commit_sha: finalSha,
    base: { ref: 'main', sha: base, repo: { full_name: repository } },
    head: { sha: head, repo: { full_name: repository } },
  };
  const identity = {
    repository,
    event: 'pull_request',
    runId: '20',
    runAttempt: '2',
    pr: '3',
    base,
    head,
    commit: mergeSha,
    tree: treeSha,
  };
  const responses = {
    [`commits/${finalSha}`]: [
      { sha: finalSha, parents: [{ sha: base }], commit: { tree: { sha: treeSha } } },
    ],
    [`commits/${finalSha}/pulls?per_page=100`]: [pr],
    'pulls/3': [pr],
    'actions/workflows/ci.yml': [{ id: 5 }],
    [`actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=100`]: [
      { workflow_runs: [run] },
    ],
    'check-suites/8': [{ app: { slug: 'github-actions' }, head_sha: head }],
    'actions/runs/20/attempts/2/jobs?per_page=100': [
      {
        jobs: fullSourceJobs.map((name, i) => ({
          id: i + 1,
          name,
          run_id: 20,
          head_sha: head,
          status: 'completed',
          conclusion: 'success',
        })),
      },
    ],
    [`commits/${mergeSha}`]: [
      {
        sha: mergeSha,
        parents: [{ sha: base }, { sha: head }],
        commit: { tree: { sha: treeSha } },
      },
    ],
  };
  for (const commit of [base, head, mergeSha, finalSha])
    responses[`git/trees/${commit}`] = [
      {
        tree: [
          { path: '.github', type: 'tree', sha: sha('f') },
          { path: 'scripts', type: 'tree', sha: sha('1') },
        ],
      },
    ];
  for (const commit of [base, head])
    responses[`git/trees/${commit}?recursive=1`] = [
      {
        truncated: false,
        tree: [
          { path: 'package.json', mode: '100644', type: 'blob', sha: sha('3') },
          { path: 'apps/web/package.json', mode: '100644', type: 'blob', sha: sha('4') },
          { path: 'vitest.config.ts', mode: '100644', type: 'blob', sha: sha('5') },
        ],
      },
    ];
  const api = (endpoint) => {
    const key = endpoint.replace(`repos/${repository}/`, '');
    if (!(key in responses)) throw new Error(`unexpected endpoint ${endpoint}`);
    return responses[key];
  };
  const logs = () => `2026-10-09T20:00:00Z CI_SOURCE_IDENTITY=${JSON.stringify(identity)}\n`;
  return {
    run,
    pr,
    identity,
    responses,
    api,
    logs,
    verify: () => verifyMergeEvidence(repository, finalSha, api, logs, base),
  };
}

it('binds the final squash tree to the GitHub simulation, trusted jobs and exact attempt', () => {
  const f = fixture();
  expect(f.verify()).toMatchObject({
    gitSha: finalSha,
    treeSha,
    mergeSha,
    baseSha: base,
    headSha: head,
    runId: 20,
    runAttempt: 2,
  });
});

it.each([
  [
    'no-op root package script',
    (f) => {
      f.responses[`git/trees/${head}?recursive=1`][0].tree[0].sha = sha('2');
    },
  ],
  [
    'no-op package build script',
    (f) => {
      f.responses[`git/trees/${head}?recursive=1`][0].tree[1].sha = sha('2');
    },
  ],
  [
    'modified test config',
    (f) => {
      f.responses[`git/trees/${head}?recursive=1`][0].tree[2].sha = sha('2');
    },
  ],
  [
    'truncated recipe tree',
    (f) => {
      f.responses[`git/trees/${head}?recursive=1`][0].truncated = true;
    },
  ],

  [
    'direct push',
    (f) => {
      f.responses[`commits/${finalSha}/pulls?per_page=100`] = [];
    },
  ],
  [
    'ambiguous PR',
    (f) => {
      f.responses[`commits/${finalSha}/pulls?per_page=100`].push(f.pr);
    },
  ],
  [
    'fork head',
    (f) => {
      f.pr.head.repo.full_name = 'fork/Mizar';
    },
  ],
  [
    'foreign base',
    (f) => {
      f.pr.base.repo.full_name = 'other/Mizar';
    },
  ],
  [
    'base drift',
    (f) => {
      f.pr.base.sha = sha('2');
    },
  ],
  [
    'head drift',
    (f) => {
      f.identity.head = sha('2');
    },
  ],
  [
    'wrong final tree',
    (f) => {
      f.responses[`commits/${finalSha}`][0].commit.tree.sha = sha('2');
    },
  ],
  [
    'wrong simulation tree',
    (f) => {
      f.responses[`commits/${mergeSha}`][0].commit.tree.sha = sha('2');
    },
  ],
  [
    'wrong merge parent',
    (f) => {
      f.responses[`commits/${mergeSha}`][0].parents[0].sha = sha('2');
    },
  ],
  [
    'non-squash merge',
    (f) => {
      f.responses[`commits/${finalSha}`][0].parents.push({ sha: head });
    },
  ],
  [
    'failed latest run',
    (f) => {
      f.responses[
        `actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=100`
      ][0].workflow_runs.push({ ...f.run, id: 21, conclusion: 'failure' });
    },
  ],
  [
    'running latest attempt',
    (f) => {
      f.run.status = 'in_progress';
    },
  ],
  [
    'foreign run',
    (f) => {
      f.run.repository.full_name = 'other/Mizar';
    },
  ],
  [
    'wrong workflow',
    (f) => {
      f.run.workflow_id = 9;
    },
  ],
  [
    'malicious workflow path',
    (f) => {
      f.run.path = '.github/workflows/evil.yml';
    },
  ],
  [
    'wrong check suite',
    (f) => {
      f.responses['check-suites/8'][0].app.slug = 'fake-ci';
    },
  ],
  [
    'wrong attempt log',
    (f) => {
      f.identity.runAttempt = '1';
    },
  ],
  [
    'wrong run log',
    (f) => {
      f.identity.runId = '19';
    },
  ],
  [
    'missing shard',
    (f) => {
      f.responses['actions/runs/20/attempts/2/jobs?per_page=100'][0].jobs.splice(6, 1);
    },
  ],
  [
    'skipped job',
    (f) => {
      f.responses['actions/runs/20/attempts/2/jobs?per_page=100'][0].jobs[1].conclusion = 'skipped';
    },
  ],
  [
    'wrong job run',
    (f) => {
      f.responses['actions/runs/20/attempts/2/jobs?per_page=100'][0].jobs[1].run_id = 19;
    },
  ],
  [
    'wrong job head',
    (f) => {
      f.responses['actions/runs/20/attempts/2/jobs?per_page=100'][0].jobs[1].head_sha = sha('2');
    },
  ],
  [
    'duplicate job',
    (f) => {
      const jobs = f.responses['actions/runs/20/attempts/2/jobs?per_page=100'][0].jobs;
      jobs.push(jobs[0]);
    },
  ],
  [
    'self-modified workflow',
    (f) => {
      f.responses[`git/trees/${head}`][0].tree[0].sha = sha('2');
    },
  ],
  [
    'self-modified harness',
    (f) => {
      f.responses[`git/trees/${head}`][0].tree[1].sha = sha('2');
    },
  ],
])('fails closed: %s', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => f.verify()).toThrow();
});

it('rejects absent/duplicate/untrusted identity logs and API failures', () => {
  const f = fixture();
  for (const logs of [() => '', () => f.logs() + f.logs(), () => 'CI_SOURCE_IDENTITY={}\n']) {
    expect(() => verifyMergeEvidence(repository, finalSha, f.api, logs, base)).toThrow();
  }
  expect(() =>
    verifyMergeEvidence(
      repository,
      finalSha,
      () => {
        throw new Error('API unavailable');
      },
      f.logs,
    ),
  ).toThrow('API unavailable');
  expect(() => verifyMergeEvidence(repository, finalSha, f.api, f.logs, sha('2'))).toThrow(
    'push 基线漂移',
  );
});
