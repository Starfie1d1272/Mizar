import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { verifySourceCi } from './verify-source-ci.mjs';
import { fullSourceJobs } from '../ci/source-contract.mjs';

test('verifySourceCi accepts passing main CI run with all required jobs', () => {
  const sha = 'a'.repeat(40);
  const repo = 'Starfie1d1272/Mizar';
  const fakeApi = (endpoint) => {
    if (endpoint.includes('/workflows/ci.yml/runs')) {
      return [
        {
          workflow_runs: [
            {
              id: 42,
              run_attempt: 1,
              head_sha: sha,
              head_repository: { full_name: repo },
              head_branch: 'main',
              path: '.github/workflows/ci.yml',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/Starfie1d1272/Mizar/actions/runs/42',
            },
          ],
        },
      ];
    }
    return [
      {
        jobs: fullSourceJobs.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
          run_id: 42,
          head_sha: sha,
        })),
      },
    ];
  };
  const result = verifySourceCi(repo, sha, fakeApi);
  assert.equal(result.gitSha, sha);
  assert.equal(result.runId, 42);
});

test('verify-source-ci CLI --sha rejects invalid sha without creating manifest', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ['scripts/qualification/verify-source-ci.mjs', '--sha', 'bad'],
        {
          env: { ...process.env, GH_REPO: 'Starfie1d1272/Mizar' },
          encoding: 'utf8',
          stdio: 'pipe',
        },
      ),
    /无效的 CI 仓库或源码 SHA/,
  );
});
