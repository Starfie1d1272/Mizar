import { githubApi } from './verify-merge-evidence.mjs';
import { pathToFileURL } from 'node:url';

const elapsed = (start, end) =>
  start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
const firstStart = (jobs) =>
  jobs
    .map((j) => j.started_at)
    .filter(Boolean)
    .sort()[0];

export function ciTimingReport(
  repository,
  run,
  jobs,
  firstAttemptJobs = run.run_attempt === 1 ? jobs : [],
) {
  const gate = jobs.filter((job) => job.name === 'ci-gate');
  if (run.status !== 'completed' || gate.length !== 1 || !gate[0].completed_at)
    throw new Error('run/gate is not terminal');
  return {
    repository,
    runId: run.id,
    attempt: run.run_attempt,
    headSha: run.head_sha,
    event: run.event,
    conclusion: run.conclusion,
    url: run.html_url,
    wallSeconds: elapsed(run.created_at, run.updated_at),
    gateWallSeconds: elapsed(run.created_at, gate[0].completed_at),
    initialQueueSeconds: elapsed(run.created_at, firstStart(firstAttemptJobs)),
    attemptQueueSeconds: elapsed(run.run_started_at, firstStart(jobs)),
    jobs: jobs.map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      secondsFromRunCreationToStart: elapsed(run.created_at, job.started_at),
      executionSeconds: elapsed(job.started_at, job.completed_at),
      steps: job.steps.map((step) => ({
        name: step.name,
        conclusion: step.conclusion,
        executionSeconds: elapsed(step.started_at, step.completed_at),
      })),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, runId] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? ''))
    throw new Error('usage: measure-run.mjs owner/repository run-id');
  const api = (path) => githubApi(`repos/${repository}/${path}`);
  const run = api(`actions/runs/${runId}`)[0];
  const jobsFor = (attempt) =>
    api(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`).flatMap((page) => page.jobs);
  const jobs = jobsFor(run.run_attempt);
  const firstAttemptJobs = run.run_attempt === 1 ? jobs : jobsFor(1);
  console.log(JSON.stringify(ciTimingReport(repository, run, jobs, firstAttemptJobs), null, 2));
}
