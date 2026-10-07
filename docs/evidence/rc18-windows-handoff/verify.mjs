import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';

const root = new URL('./', import.meta.url);
const sums = (await readFile(new URL('SHA256SUMS', root), 'utf8')).trim().split('\n');
for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
  if (!match) throw new Error('Malformed checksum entry');
  const [, expected, name] = match;
  const bytes = await readFile(new URL(name, root));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch: ${name}`);
  if (name.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
  if (name.endsWith('.jsonl.gz')) {
    for (const row of gunzipSync(bytes).toString('utf8').trim().split('\n')) JSON.parse(row);
  }
}
const frames = gunzipSync(await readFile(new URL('same-map-restart-input.jsonl.gz', root)))
  .toString('utf8')
  .trim()
  .split('\n')
  .map((row) => JSON.parse(row));
if (frames.length !== 451 || frames.some((frame, index) => frame.sequence !== 7400 + index)) {
  throw new Error('Restart excerpt sequence mismatch');
}
const rc19 = gunzipSync(await readFile(new URL('rc19-same-process-restart-input.jsonl.gz', root)))
  .toString('utf8')
  .trim()
  .split('\n')
  .map((row) => JSON.parse(row));
if (rc19.length !== 81 || rc19.some((frame, index) => frame.sequence !== 20630 + index)) {
  throw new Error('RC19 restart excerpt sequence mismatch');
}
const warmup = rc19.find((frame) => frame.sequence === 20641).payload.map;
if (
  warmup.phase !== 'warmup' ||
  warmup.round !== 0 ||
  warmup.team_ct.score !== 0 ||
  warmup.team_t.score !== 0 ||
  Object.hasOwn(warmup, 'round_wins')
) {
  throw new Error('RC19 omitted-history warmup witness mismatch');
}
console.log(
  JSON.stringify({
    directory: fileURLToPath(root),
    files: sums.length,
    excerptFrames: frames.length,
    result: 'PASS',
  }),
);
