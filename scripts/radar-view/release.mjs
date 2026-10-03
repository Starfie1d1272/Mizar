import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseMetadata(ref, version) {
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'Invalid package version');
  assert.equal(ref, `refs/tags/radar-view-v${version}`, 'Release tag must match package version');
  return { tag: version.includes('-') ? 'next' : 'latest' };
}
export function requireSuccessfulCI(runs, sha, repository) {
  const run = runs.find(
    (candidate) =>
      candidate.head_sha === sha &&
      candidate.head_repository?.full_name === repository &&
      ['pull_request', 'push'].includes(candidate.event),
  );
  assert(
    run && run.status === 'completed' && run.conclusion === 'success',
    'The latest CI run for this exact revision must have completed successfully',
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('packages/radar-view/package.json', 'utf8'));
  const metadata = releaseMetadata(process.env.GITHUB_REF, manifest.version);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'Starfie1d1272/Mizar');
  const result = JSON.parse(
    execFileSync(
      'gh',
      ['api', `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`],
      { encoding: 'utf8' },
    ),
  );
  requireSuccessfulCI(result.workflow_runs, sha, repository);
  appendFileSync(process.env.GITHUB_OUTPUT, `dist_tag=${metadata.tag}\n`);
}
