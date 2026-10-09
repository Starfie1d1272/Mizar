import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyBrowserShards } from './test-evidence.mjs';

const root = process.argv[2];
const count = Number(process.argv[3]);
const attempt = process.argv[4];
if (attempt !== undefined && !/^[1-9][0-9]*$/.test(attempt))
  throw new Error('invalid evidence attempt');
if (!root || !Number.isSafeInteger(count) || count < 1)
  throw new Error('expected evidence directory and shard count');
const shards = Array.from({ length: count }, (_, index) => {
  const directory = join(
    root,
    `browser-evidence-${attempt ? `${attempt}-` : ''}${index + 1}`,
    'test-evidence',
    `${index + 1}-${count}`,
  );
  const read = (name) => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
  return { full: read('full'), selected: read('selected'), actual: read('actual') };
});
console.log(JSON.stringify(verifyBrowserShards(shards)));
