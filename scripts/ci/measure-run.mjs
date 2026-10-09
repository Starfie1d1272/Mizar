import { githubApi } from './verify-merge-evidence.mjs';

const [repository, runId] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? ''))
  throw new Error('usage: measure-run.mjs owner/repository run-id');
const api = (path) => githubApi(`repos/${repository}/${path}`);
const run = api(`actions/runs/${runId}`)[0];
const jobs = api(`actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`).flatMap(
  (page) => page.jobs,
);
const gate = jobs.filter((job) => job.name === 'ci-gate');
if (run.status !== 'completed' || gate.length !== 1 || !gate[0].completed_at)
  throw new Error('run/gate is not terminal');
const elapsed = (start, end) =>
  start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
console.log(
  JSON.stringify(
    {
      repository,
      runId: run.id,
      attempt: run.run_attempt,
      headSha: run.head_sha,
      event: run.event,
      conclusion: run.conclusion,
      url: run.html_url,
      wallSeconds: elapsed(run.created_at, gate[0].completed_at),
      initialQueueSeconds: elapsed(run.created_at, run.run_started_at),
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
    },
    null,
    2,
  ),
);
