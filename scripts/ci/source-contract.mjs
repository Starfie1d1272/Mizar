// One contract for source validation; release artifacts remain exact-main-SHA.
export const fullSourceJobs = Object.freeze([
  'build',
  'quality',
  'native build / Windows',
  'ci-gate',
]);

export function assertSuccessfulJobs(jobs, names, run) {
  for (const name of names) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success' ||
      matches[0].run_id !== run.id ||
      matches[0].head_sha !== run.head_sha
    ) {
      throw new Error(`缺少完整 CI 成功证据：${name}`);
    }
  }
}
