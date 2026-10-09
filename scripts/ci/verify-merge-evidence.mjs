import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullSourceJobs, assertSuccessfulJobs } from './source-contract.mjs';

export function githubApi(endpoint) {
  // One compact JSON value per page also supports older gh without --slurp.
  const output = execFileSync('gh', ['api', '--paginate', '--jq', 'tojson', endpoint], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return output
    .trim()
    .split('\n')
    .map((page) => JSON.parse(page));
}
export function githubJobLogs(repository, jobId) {
  return execFileSync('gh', ['api', `repos/${repository}/actions/jobs/${jobId}/logs`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}
const shaPattern = /^[a-f0-9]{40}$/;
const one = (pages) => {
  if (pages.length !== 1) throw new Error('API 身份不唯一');
  return pages[0];
};
const requireFact = (condition, reason) => {
  if (!condition) throw new Error(`不能复用 PR CI：${reason}`);
};

/** Only GitHub-owned run/job metadata and the immutable trusted plan job log
 * establish identity. No PR-provided artifact is accepted as validation proof. */
export function verifyMergeEvidence(
  repository,
  sourceSha,
  api = githubApi,
  logs = githubJobLogs,
  expectedBase,
) {
  requireFact(
    /^[\w.-]+\/[\w.-]+$/.test(repository) && shaPattern.test(sourceSha),
    '仓库或 SHA 无效',
  );
  const get = (path) => one(api(`repos/${repository}/${path}`));
  const final = get(`commits/${sourceSha}`);
  requireFact(final.sha === sourceSha && final.parents?.length === 1, '只复用精确 squash 提交');
  const base = final.parents[0].sha;
  requireFact(!expectedBase || base === expectedBase, 'push 基线漂移');
  const prs = api(`repos/${repository}/commits/${sourceSha}/pulls?per_page=100`).flat();
  const matches = prs.filter(
    (pr) => pr.merged_at && pr.merge_commit_sha === sourceSha && pr.base?.ref === 'main',
  );
  requireFact(matches.length === 1, '必须有唯一已合并 PR；直接 push 不可信复用');
  const pr = get(`pulls/${matches[0].number}`);
  requireFact(
    pr.merged_at &&
      pr.merge_commit_sha === sourceSha &&
      pr.base?.ref === 'main' &&
      pr.base?.repo?.full_name === repository &&
      pr.head?.repo?.full_name === repository &&
      pr.base.sha === base &&
      shaPattern.test(pr.head.sha),
    'PR 仓库、基线或合并身份不符',
  );
  const workflow = get('actions/workflows/ci.yml');
  const runs = api(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`,
  )
    .flatMap((page) => page.workflow_runs)
    .filter((run) => run.head_sha === pr.head.sha && run.event === 'pull_request')
    .sort((a, b) => b.id - a.id);
  const run = runs[0];
  requireFact(
    run &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_repository?.full_name === repository &&
      run.repository?.full_name === repository &&
      run.workflow_id === workflow.id &&
      run.path === '.github/workflows/ci.yml' &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    '最新可信 run/attempt 未成功',
  );
  const suite = get(`check-suites/${run.check_suite_id}`);
  requireFact(
    suite.app?.slug === 'github-actions' && suite.head_sha === pr.head.sha,
    'check suite 身份不符',
  );
  const jobs = api(
    `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  ).flatMap((page) => page.jobs);
  assertSuccessfulJobs(jobs, fullSourceJobs, run);
  // The marker is emitted by an inline workflow step before any PR executable
  // code runs. GitHub logs cannot be replaced by a PR artifact upload.
  const markers = [
    ...logs(repository, jobs.find((job) => job.name === 'plan').id).matchAll(
      /(?:^|\n)[^\n]*?CI_SOURCE_IDENTITY=(\{[^\n]+\})\r?(?=\n|$)/g,
    ),
  ];
  requireFact(markers.length === 1, '缺少唯一可信 merge identity 日志');
  const identity = JSON.parse(markers[0][1]);
  requireFact(
    identity.repository === repository &&
      identity.event === 'pull_request' &&
      identity.runId === String(run.id) &&
      identity.runAttempt === String(run.run_attempt) &&
      identity.pr === String(pr.number) &&
      identity.base === base &&
      identity.head === pr.head.sha &&
      shaPattern.test(identity.commit) &&
      shaPattern.test(identity.tree),
    '日志 run/attempt/PR 身份不符',
  );
  const merge = get(`commits/${identity.commit}`);
  requireFact(
    merge.sha === identity.commit &&
      merge.parents?.length === 2 &&
      merge.parents[0].sha === base &&
      merge.parents[1].sha === pr.head.sha &&
      merge.commit?.tree?.sha === identity.tree &&
      final.commit?.tree?.sha === identity.tree,
    '模拟合并关系或最终 tree 不符',
  );
  // Workflow, local actions and every planner/harness dependency must already
  // be trusted on the base. Self-modifying CI changes require full main CI.
  const trustedTrees = [base, pr.head.sha, identity.commit, sourceSha].map((sha) =>
    get(`git/trees/${sha}`),
  );
  const subtree = (tree, path) =>
    tree.tree?.find((entry) => entry.path === path && entry.type === 'tree')?.sha;
  for (const path of ['.github', 'scripts']) {
    const values = trustedTrees.map((tree) => subtree(tree, path));
    requireFact(
      values.every((value) => value && value === values[0]),
      `受信任 ${path} 执行定义改变`,
    );
  }
  // pnpm entrypoints/configuration are part of the execution recipe too:
  // unchanged YAML alone cannot stop a PR redefining "test" as a no-op.
  const recipes = [base, pr.head.sha].map((sha) => get(`git/trees/${sha}?recursive=1`));
  requireFact(
    recipes.every((recipe) => !recipe.truncated),
    '执行配置 tree 被截断',
  );
  const recipeEntries = (recipe) =>
    recipe.tree
      .filter(
        (entry) =>
          /(?:^|\/)package\.json$/.test(entry.path) ||
          /(?:^|\/)tsconfig[^/]*\.json$/.test(entry.path) ||
          /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs|eslint\.config\.[^/]+|vitest\.config\.[^/]+|playwright[^/]*\.config\.[^/]+)$/.test(
            entry.path,
          ),
      )
      .map(({ path, mode, type, sha }) => ({ path, mode, type, sha }))
      .sort((a, b) => a.path.localeCompare(b.path));
  requireFact(
    JSON.stringify(recipeEntries(recipes[0])) === JSON.stringify(recipeEntries(recipes[1])),
    '包脚本、依赖或测试执行配置改变',
  );
  return {
    gitSha: sourceSha,
    treeSha: identity.tree,
    baseSha: base,
    headSha: pr.head.sha,
    mergeSha: identity.commit,
    pr: pr.number,
    runId: run.id,
    runAttempt: run.run_attempt,
    url: run.html_url,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        verifyMergeEvidence(
          process.env.GITHUB_REPOSITORY,
          process.env.GITHUB_SHA,
          githubApi,
          githubJobLogs,
          process.env.BEFORE_SHA,
        ),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
