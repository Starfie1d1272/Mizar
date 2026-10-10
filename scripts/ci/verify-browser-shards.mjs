import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserShards } from './test-evidence.mjs';

export function readBrowserShards(root, count, { attempt, runId, sourceSha }) {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error('invalid evidence shard count or attempt');
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[a-f0-9]{40}$/.test(sourceSha))
    throw new Error('expected exact workflow run and source identity');
  const latest = new Map();
  for (const name of readdirSync(root)) {
    const match = /^browser-evidence-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(name);
    if (!match) throw new Error('unexpected browser evidence directory');
    const evidenceAttempt = Number(match[1]);
    const shard = Number(match[2]);
    if (evidenceAttempt > attempt || shard > count)
      throw new Error('browser evidence belongs to an unexpected attempt or shard');
    if (!latest.has(shard) || evidenceAttempt > latest.get(shard).attempt)
      latest.set(shard, { name, attempt: evidenceAttempt });
  }
  return Array.from({ length: count }, (_, index) => {
    const shard = index + 1;
    const evidence = latest.get(shard);
    if (!evidence) throw new Error(`missing browser shard ${shard}`);
    const directory = join(root, evidence.name, 'test-evidence', `${shard}-${count}`);
    const read = (name) => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
    const identity = read('identity');
    if (
      identity.runId !== runId ||
      identity.sourceSha !== sourceSha ||
      identity.attempt !== evidence.attempt ||
      identity.shard !== shard ||
      identity.count !== count
    )
      throw new Error('browser evidence workflow/source/shard identity differs');
    // A failed/corrupt newest shard must never fall back to an earlier passing artifact.
    return { full: read('full'), selected: read('selected'), actual: read('actual') };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shards = readBrowserShards(process.argv[2], Number(process.argv[3]), {
    attempt: Number(process.argv[4]),
    runId: process.env.GITHUB_RUN_ID,
    sourceSha: process.env.GITHUB_SHA,
  });
  console.log(JSON.stringify(verifyBrowserShards(shards)));
}
