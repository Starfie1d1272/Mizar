// One contract for source validation; release artifacts remain exact-main-SHA.
export const fullSourceJobs = Object.freeze([
  'plan',
  ...['static', 'unit', 'fixtures', 'build'].map((lane) => `quality / ${lane}`),
  'design',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) => `acceptance / ${shard} of 8`),
  'platform / Windows',
  'native / Windows',
  'installer / Windows / update',
  'installer / Windows / faults',
  'qualification / offline / Linux',
  'qualification / offline / macOS',
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
