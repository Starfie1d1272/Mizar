import { strict as assert } from 'node:assert';
import { browserIdentities } from './test-evidence.mjs';

// Keep a file together: serial hooks and shared Companion state retain their isolation.
export function balanceBrowserFiles(full, count, durations = {}) {
  assert(Number.isSafeInteger(count) && count > 0, 'invalid browser shard count');
  assert.equal(full.errors?.length ?? 0, 0, 'FULL discovery failed');
  const files = new Map();
  for (const { id } of browserIdentities(full)) {
    const [, file] = JSON.parse(id);
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  assert(files.size >= count, 'browser shards would contain empty selections');
  const jobs = [...files].map(([file, tests]) => {
    const weight = durations[file] ?? tests * 1000;
    assert(Number.isFinite(weight) && weight > 0, `invalid browser duration: ${file}`);
    return { file, weight };
  });
  jobs.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], estimatedMs: 0 }));
  for (const job of jobs) {
    const lane = shards.reduce((best, candidate) =>
      candidate.estimatedMs < best.estimatedMs ? candidate : best,
    );
    lane.files.push(job.file);
    lane.estimatedMs += job.weight;
  }
  for (const lane of shards) lane.files.sort();
  return shards;
}
