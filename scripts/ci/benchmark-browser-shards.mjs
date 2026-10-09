import { spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { browserIdentities, verifyBrowserShards } from './test-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const [mode, countText, output] = process.argv.slice(2);
const count = Number(countText);
if (
  !['baseline', 'balanced'].includes(mode) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !output
)
  throw new Error('expected baseline|balanced shard-count output-directory; build packages first');
const outputDir = resolve(output);
mkdirSync(outputDir, { recursive: true });
rmSync(resolve(outputDir, 'summary.json'), { force: true });
const timings = [];
const shards = [];
const files = {};
for (let current = 1; current <= count; current++) {
  const log = openSync(resolve(outputDir, `shard-${current}.log`), 'w');
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    ['scripts/ci/acceptance.mjs', `--shard=${current}/${count}`],
    {
      cwd: root,
      env: { ...process.env, MIZAR_BROWSER_SHARDING: mode === 'balanced' ? 'balanced' : '' },
      stdio: ['ignore', log, log],
    },
  );
  closeSync(log);
  const timing = {
    shard: `${current}/${count}`,
    wallMs: performance.now() - started,
    status: child.status,
  };
  timings.push(timing);
  writeFileSync(resolve(outputDir, 'timings.json'), JSON.stringify({ mode, timings }, null, 2));
  console.log(JSON.stringify(timing));
  if (child.status !== 0) process.exit(child.status ?? 1);
  const source = resolve(root, '.agent-tmp/test-evidence', `${current}-${count}`);
  const target = resolve(
    outputDir,
    `browser-evidence-${current}`,
    'test-evidence',
    `${current}-${count}`,
  );
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  const read = (name) => JSON.parse(readFileSync(resolve(source, `${name}.json`), 'utf8'));
  const shard = { full: read('full'), selected: read('selected'), actual: read('actual') };
  shards.push(shard);
  for (const { id, results } of browserIdentities(shard.actual)) {
    const [, file] = JSON.parse(id);
    files[file] = (files[file] ?? 0) + results[0].duration;
  }
}
const proof = verifyBrowserShards(shards);
writeFileSync(
  resolve(outputDir, 'summary.json'),
  JSON.stringify(
    {
      mode,
      count,
      ...proof,
      maxWallMs: Math.max(...timings.map((lane) => lane.wallMs)),
      timings,
      files,
    },
    null,
    2,
  ),
);
