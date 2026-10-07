import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import console from 'node:console';

const root = new URL('./', import.meta.url);
const sums = (await readFile(new URL('SHA256SUMS', root), 'utf8')).trim().split('\n');
for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
  if (!match) throw Error('Malformed checksum');
  const [, expected, name] = match;
  const bytes = await readFile(new URL(name, root));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error(name);
  if (name.endsWith('.json')) JSON.parse(bytes.toString());
  if (name.endsWith('.jsonl'))
    for (const row of bytes.toString().trim().split('\n')) JSON.parse(row);
}
const frames = gunzipSync(await readFile(new URL('nuke-final-input.jsonl.gz', root)))
  .toString()
  .trim()
  .split('\n')
  .map(JSON.parse);
if (frames.length !== 381 || frames.some((f, i) => f.sequence !== 71500 + i))
  throw Error('Sequence');
const final = frames.find((f) => f.sequence === 71662).payload;
if (
  final.map.phase !== 'gameover' ||
  final.map.round !== 18 ||
  final.round.phase !== 'freezetime' ||
  final.map.team_ct.score !== 5 ||
  final.map.team_t.score !== 13 ||
  Object.keys(final.map.round_wins).length !== 18
)
  throw Error('Final evidence');
const replay = JSON.parse(await readFile(new URL('rc21-nuke-history-replay.json', root)));
if (replay.history.rounds.length !== 18 || replay.seriesScore.a !== 1 || replay.seriesScore.b !== 0)
  throw Error('Replay history');
const stats = JSON.parse(await readFile(new URL('rc21-nuke-stats-replay.json', root)));
if (stats.frames !== 37695 || stats.countedCompletedRounds !== 18) throw Error('Replay stats');
console.log(`Verified ${sums.length} files and 381 final-round input frames`);
