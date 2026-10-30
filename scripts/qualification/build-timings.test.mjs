import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildTimer } from './build-timings.mjs';

test('concurrent phase completions preserve every timing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-timings-'));
  try {
    const timed = createBuildTimer(directory, { gitSha: 'test' });
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => timed(`phase-${index}`, async () => {})),
    );
    const result = JSON.parse(await readFile(join(directory, 'build-timings.json'), 'utf8'));
    assert.equal(result.phases.length, 30);
    assert.equal(new Set(result.phases.map(({ phase }) => phase)).size, 30);
    assert.ok(result.phases.every(({ status }) => status === 'success'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
