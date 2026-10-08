import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Full CI, including the stable aggregate gate; a docs-only push is insufficient.
export const requiredJobs = [
  'plan',
  ...['static', 'unit', 'fixtures', 'build'].map((lane) => `quality / ${lane}`),
  'design',
  ...[1, 2, 3, 4].map((shard) => `acceptance / ${shard} of 4`),
  'platform / macOS',
  'platform / Windows',
  'qualification / Windows bundle',
  'qualification / offline / Linux',
  'qualification / offline / macOS',
  'ci-gate',
];

function githubPages(endpoint) {
  return JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], { encoding: 'utf8' }),
  );
}

export function verifySourceCi(repository, sourceSha, api = githubPages) {
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
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') {
      throw new Error(`缺少完整 CI 成功证据：${name}；请在该 SHA 上手动运行完整 CI`);
    }
  }
  return { gitSha: sourceSha, runId: run.id, runAttempt: run.run_attempt, url: run.html_url };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , manifestPath, output] = process.argv;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const evidence = verifySourceCi(process.env.GH_REPO, manifest.gitSha);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`完整 CI 已通过：${evidence.url}`);
}
