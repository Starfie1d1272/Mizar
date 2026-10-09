import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fullSourceJobs, assertSuccessfulJobs } from '../ci/source-contract.mjs';
import { verifyMergeEvidence, githubApi } from '../ci/verify-merge-evidence.mjs';

export const requiredJobs = fullSourceJobs;

export function verifySourceCi(repository, sourceSha, api = githubApi, options = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('无效的 CI 仓库或源码 SHA');
  }
  const runs = api(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sourceSha}&per_page=100`,
  )
    .flatMap((page) => page.workflow_runs)
    .filter(
      (run) =>
        run.head_sha === sourceSha &&
        run.head_repository?.full_name === repository &&
        run.head_branch === 'main' &&
        run.path === '.github/workflows/ci.yml' &&
        ['push', 'workflow_dispatch', 'schedule'].includes(run.event),
    )
    .sort((a, b) => b.id - a.id);
  const run = runs[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('产品真实源码的最新 CI 未成功；请在该 SHA 上运行完整 CI 后重试晋级');
  }
  const jobs = api(
    `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  ).flatMap((page) => page.jobs);
  const incomplete = requiredJobs.some((name) => {
    const matches = jobs.filter((job) => job.name === name);
    return matches.length !== 1 || matches[0].conclusion !== 'success';
  });
  if (incomplete && options.allowMergeReuse) {
    // Even reuse requires a successful exact-main run and aggregate gate.
    assertSuccessfulJobs(jobs, ['plan', 'ci-gate'], run);
    return verifyMergeEvidence(repository, sourceSha, api, options.logs);
  }
  assertSuccessfulJobs(jobs, requiredJobs, run);
  return { gitSha: sourceSha, runId: run.id, runAttempt: run.run_attempt, url: run.html_url };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , manifestPath, output] = process.argv;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const evidence = verifySourceCi(process.env.GH_REPO, manifest.gitSha);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`完整 CI 已通过：${evidence.url}`);
}
