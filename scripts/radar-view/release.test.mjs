import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseMetadata, requireSuccessfulCI } from './release.mjs';

test('release tags must exactly identify the package version; prereleases never become latest', () => {
  assert.equal(releaseMetadata('refs/tags/radar-view-v0.1.0', '0.1.0').tag, 'latest');
  assert.equal(releaseMetadata('refs/tags/radar-view-v0.2.0-rc.1', '0.2.0-rc.1').tag, 'next');
  for (const ref of ['refs/heads/main', 'refs/tags/v0.1.0', 'refs/tags/radar-view-v0.2.0'])
    assert.throws(() => releaseMetadata(ref, '0.1.0'));
});
test('publishing requires successful CI from the exact revision and repository', () => {
  const run = {
    head_sha: 'abc',
    head_repository: { full_name: 'owner/repo' },
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
  };
  requireSuccessfulCI([run], 'abc', 'owner/repo');
  for (const patch of [
    { head_sha: 'other' },
    { head_repository: { full_name: 'fork/repo' } },
    { event: 'workflow_dispatch' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ])
    assert.throws(() => requireSuccessfulCI([{ ...run, ...patch }], 'abc', 'owner/repo'));
  assert.throws(() => requireSuccessfulCI([], 'abc', 'owner/repo'));
  assert.throws(() =>
    requireSuccessfulCI([{ ...run, conclusion: 'failure' }, run], 'abc', 'owner/repo'),
  );
});
