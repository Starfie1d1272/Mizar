import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyBrowserShards } from './test-evidence.mjs';

const root = process.argv[2];
const count = Number(process.argv[3]);
if (!root || !Number.isSafeInteger(count) || count < 1)
  throw new Error('expected evidence directory and shard count');
const shards = Array.from({ length: count }, (_, index) => {
  const directory = join(
    root,
    `browser-evidence-${index + 1}`,
    'test-evidence',
    `${index + 1}-${count}`,
  );
  const read = (name) => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
  return { full: read('full'), selected: read('selected'), actual: read('actual') };
});
console.log(JSON.stringify(verifyBrowserShards(shards)));
