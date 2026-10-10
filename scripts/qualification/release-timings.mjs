import { readFile, writeFile, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repository = 'Starfie1d1272/Mizar';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const api = (path) =>
  JSON.parse(
    execFileSync('gh', ['api', `repos/${repository}/${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
const elapsed = (start, end) => {
  const value = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid release timing order');
  return value;
};
function runTiming(run, jobs, completedAt) {
  const starts = jobs
    .filter((job) => job.started_at)
    .map((job) => job.started_at)
    .sort();
  return {
    id: run.id,
    createdAt: run.created_at,
    completedAt,
    durationMs: elapsed(run.created_at, completedAt),
    initialQueueMs: starts.length ? elapsed(run.created_at, starts[0]) : null,
    jobs: jobs.map(({ name, started_at, completed_at }) => ({
      name,
      startedAt: started_at,
      completedAt: completed_at,
    })),
  };
}

export function releaseTimingReport({
  qualification,
  promotion,
  box,
  jobs,
  finishedAt,
  tag,
  sourceSha,
  publishedAt,
  recovery,
  build,
}) {
  if (
    qualification.path !== '.github/workflows/release-qualification.yml' ||
    qualification.conclusion !== 'success' ||
    qualification.head_branch !== 'main' ||
    qualification.head_sha !== sourceSha ||
    qualification.event !== 'workflow_dispatch' ||
    promotion.path !== '.github/workflows/release-promotion.yml' ||
    promotion.head_branch !== 'main' ||
    promotion.event !== 'workflow_dispatch' ||
    (box &&
      (promotion.conclusion !== 'success' ||
        box.path !== '.github/workflows/box-sync.yml' ||
        box.head_branch !== 'main' ||
        box.event !== 'workflow_run'))
  )
    throw new Error('Release timing source differs');
  elapsed(qualification.updated_at, promotion.created_at);
  elapsed(publishedAt, box ? promotion.updated_at : finishedAt);
  if (box) {
    elapsed(promotion.updated_at, box.created_at);
    elapsed(box.created_at, finishedAt);
  }
  recovery ||=
    qualification.run_attempt !== 1 ||
    promotion.run_attempt !== 1 ||
    (box && box.run_attempt !== 1) ||
    Date.parse(publishedAt) < Date.parse(promotion.created_at);
  const result = {
    tag,
    sourceSha,
    recovery,
    publishedAt,
    build: build ? { phases: build.phases, cargoCache: build.cargoCache } : undefined,
    qualification: runTiming(qualification, jobs.qualification, qualification.updated_at),
    promotion: runTiming(promotion, jobs.promotion, box ? promotion.updated_at : finishedAt),
  };
  if (box) {
    result.box = runTiming(box, jobs.box, finishedAt);
    result.triggerToBoxMs = elapsed(qualification.created_at, finishedAt);
    result.promotionToBoxMs = elapsed(promotion.created_at, finishedAt);
    result.publishedToBoxMs = elapsed(publishedAt, finishedAt);
    // Retries or a previously published version cannot prove a fresh release budget.
    result.freshReleaseWithin600Seconds = !recovery && result.triggerToBoxMs <= 600000;
  }
  return result;
}

async function recordReport(report, path) {
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  if (report.measurementUnavailable) {
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        'Release timing unavailable; fresh-release <=600s remains unverified.\n',
      );
    return;
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Release timing: ${report.recovery ? 'recovery; not fresh-release acceptance' : 'fresh release'}; ` +
        (report.triggerToBoxMs === undefined
          ? 'Promotion checkpoint'
          : `Qualification trigger → Box verified: ${(report.triggerToBoxMs / 1000).toFixed(1)}s; initial queues Q/P/B: ${[report.qualification, report.promotion, report.box].map((r) => (r.initialQueueMs === null ? 'unknown' : (r.initialQueueMs / 1000).toFixed(1) + 's')).join('/')}`) +
        '\n',
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, output] = process.argv.slice(2);
  try {
    const finishedAt = new Date().toISOString();
    const current = api(`actions/runs/${process.env.GITHUB_RUN_ID}`);
    const currentJobs = api(`actions/runs/${current.id}/jobs?per_page=100`).jobs;
    if (mode === 'promotion') {
      const qualification = await json('qualification-run.json');
      const release = await json(
        process.env.RELEASE_ALREADY_PUBLISHED === 'true'
          ? 'existing-release.json'
          : 'published-release.json',
      );
      const build = await json('evidence-extracted/build-timings.json');
      const report = releaseTimingReport({
        qualification,
        promotion: current,
        jobs: {
          qualification: api(`actions/runs/${qualification.id}/jobs?per_page=100`).jobs,
          promotion: currentJobs,
        },
        tag: process.env.RELEASE_TAG,
        sourceSha: process.env.SOURCE_SHA,
        finishedAt: finishedAt,
        publishedAt: release.published_at,
        recovery: process.env.RELEASE_ALREADY_PUBLISHED === 'true' || current.run_attempt !== 1,
        build,
      });
      await recordReport(report, output);
    } else if (mode === 'box') {
      if (process.env.GITHUB_EVENT_NAME !== 'workflow_run') {
        await recordReport(
          {
            recovery: true,
            freshReleaseWithin600Seconds: false,
            box: runTiming(current, currentJobs, finishedAt),
          },
          output,
        );
      } else {
        const event = await json(process.env.GITHUB_EVENT_PATH);
        const promotion = api(`actions/runs/${event.workflow_run.id}`);
        const directory = await mkdtemp(join(tmpdir(), 'mizar-release-timing-'));
        try {
          execFileSync(
            'gh',
            [
              'run',
              'download',
              String(promotion.id),
              '--repo',
              repository,
              '--name',
              `promotion-records-${promotion.run_attempt}`,
              '--dir',
              directory,
            ],
            { stdio: 'pipe', timeout: 60000 },
          );
          const record = await json(join(directory, 'release-timings.json'));
          const qualification = api(`actions/runs/${record.qualification.id}`);
          await recordReport(
            releaseTimingReport({
              qualification,
              promotion,
              box: current,
              jobs: {
                qualification: api(`actions/runs/${qualification.id}/jobs?per_page=100`).jobs,
                promotion: api(`actions/runs/${promotion.id}/jobs?per_page=100`).jobs,
                box: currentJobs,
              },
              finishedAt: finishedAt,
              tag: record.tag,
              sourceSha: record.sourceSha,
              publishedAt: record.publishedAt,
              recovery: record.recovery || current.run_attempt !== 1,
              build: record.build,
            }),
            output,
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    } else throw new Error('Unknown release timing mode');
  } catch (error) {
    if (
      error.code === 'ENOENT' ||
      error instanceof SyntaxError ||
      [
        'Invalid release timing order',
        'Release timing source differs',
        'Unknown release timing mode',
      ].includes(error.message)
    )
      // eslint-disable-next-line preserve-caught-error -- Download causes may expose signed URLs.
      throw new Error('发行计时证据缺失或结构、时序有误；不得作为完整发行验收。');
    // Metrics cannot invalidate delivery after its original-byte checks succeeded.
    // Missing timing evidence also cannot claim the fresh release budget passed.
    await recordReport(
      { measurementUnavailable: true, recovery: true, freshReleaseWithin600Seconds: false },
      output,
    );
    console.warn('发布计时证据不可用；新版本600秒验收仍未完成。');
  }
}
