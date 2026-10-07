import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import console from 'node:console';
import { URL } from 'node:url';
const root = new URL('./', import.meta.url);
const sums = (await readFile(new URL('SHA256SUMS', root), 'utf8')).trim().split('\n');
for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
  if (!match) throw Error('Malformed checksum');
  const [, expected, name] = match;
  const bytes = await readFile(new URL(name, root));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error(name);
  if (name.endsWith('.json')) JSON.parse(bytes.toString());
}
const frames = gunzipSync(await readFile(new URL('nuke-terminal-input.jsonl.gz', root)))
  .toString().trim().split('\n').map(JSON.parse);
if (frames.length !== 301 || frames.some((f, i) => f.sequence !== 39650 + i)) throw Error('Sequence');
const terminal = frames.find(f => f.payload.map?.phase === 'gameover').payload;
if (terminal.map.team_ct.score !== 5 || terminal.map.team_t.score !== 13 || Object.keys(terminal.map.round_wins).length !== 18) throw Error('Terminal result');
const defect = JSON.parse(await readFile(new URL('nuke-late-kad-defect.json', root)));
if (defect.defects.length !== 3 || defect.defects.some(p => p.terminalDeaths !== p.frozenDeaths + 1)) throw Error('Late deaths');
const replay = JSON.parse(await readFile(new URL('rc22-terminal-kad-replay.json', root)));
if (replay.mismatches.length || replay.players.length !== 10 || replay.score.a !== 13 || replay.score.b !== 5) throw Error('Offline replay');
const actual = JSON.parse(await readFile(new URL('rc22-windows-terminal-result.json', root)));
if (actual.source !== '6e84cd2eaa027ae322ad486b6b2ab31e18e2d486' || actual.rows.length !== 10 || actual.mismatches.length || actual.history !== 18 || actual.score.a !== 13 || actual.score.b !== 5 || actual.rows.some(p => p.deaths !== p.observedDeaths)) throw Error('RC22 targeted Windows result');
console.log(`Verified ${sums.length} files and 301 terminal input frames`);
