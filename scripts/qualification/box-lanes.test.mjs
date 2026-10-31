import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { runLanes, runWorker } from './box-lanes.mjs';

test('lane operations retain the prior full phase sequence', async () => {
  const events = [];
  const operations = Object.fromEntries(
    ['downloadLane', 'transferLane', 'transferVerifiedRuntime', 'verifyLane'].map((name) => [
      name,
      async (...args) => events.push([name, ...args]),
    ]),
  );
  await runWorker('runtime', 'runtime-root', operations);
  await runWorker('resources', 'resources-root', operations);
  await runWorker('downloads', 'downloads-root', operations);
  assert.deepEqual(events, [
    ['downloadLane', 'runtime-root', 'runtime', 'metadata'],
    ['downloadLane', 'runtime-root', 'runtime', 'core'],
    ['transferVerifiedRuntime', 'runtime-root', 'metadata'],
    ['transferVerifiedRuntime', 'runtime-root', 'core'],
    ['downloadLane', 'resources-root', 'resources'],
    ['transferLane', 'resources-root', 'resources'],
    ['verifyLane', 'resources-root', 'resources'],
    ['downloadLane', 'downloads-root', 'downloads'],
    ['transferLane', 'downloads-root', 'downloads'],
    ['verifyLane', 'downloads-root', 'downloads'],
  ]);
});

test('failure joins other lanes, preserves earliest recovery, and provides no receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'box-lanes-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan'),
    output = join(root, 'output');
  await mkdir(plan);
  await writeFile(join(plan, 'plan.json'), 'plan');
  const old = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = output;
  t.after(() => {
    if (old === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = old;
  });
  let finish,
    settled = false;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  const started = [];
  const run = async (lane, laneRoot, result) => {
    started.push(lane);
    assert.equal(await readFile(join(laneRoot, 'plan.json'), 'utf8'), 'plan');
    if (lane === 'runtime') {
      await writeFile(result, JSON.stringify({ recovery: '2026-10-31T01:02:00.000Z' }));
      throw new Error('uncertain write');
    }
    await waiting;
    await writeFile(result, JSON.stringify({ recovery: '2026-10-31T01:01:00.000Z' }));
  };
  const operation = runLanes(plan, join(root, 'lanes'), join(root, 'receipts'), run).finally(() => {
    settled = true;
  });
  await setImmediate();
  while (started.length < 3) await setImmediate();
  assert.equal(settled, false);
  finish();
  await assert.rejects(operation, /all lanes have settled/);
  assert.match(await readFile(output, 'utf8'), /2026-10-31T01:01:00.000Z/);
  await assert.rejects(readFile(join(root, 'receipts', 'runtime.json')), { code: 'ENOENT' });
});

test('successful lanes isolate work and assemble each receipt only after all finish', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'box-lanes-success-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan');
  await mkdir(plan);
  await writeFile(join(plan, 'plan.json'), 'plan');
  const roots = [];
  await runLanes(
    plan,
    join(root, 'lanes'),
    join(root, 'receipts'),
    async (lane, laneRoot, result) => {
      roots.push(laneRoot);
      await mkdir(join(laneRoot, 'receipt'));
      await writeFile(join(laneRoot, 'receipt', `${lane}.json`), lane);
      await writeFile(result, '{}');
    },
  );
  assert.equal(new Set(roots).size, 3);
  for (const lane of ['runtime', 'resources', 'downloads'])
    assert.equal(await readFile(join(root, 'receipts', `${lane}.json`), 'utf8'), lane);
});

test('workflow gates all writes behind successful authenticated preparation and finalization behind all lanes', async () => {
  const yaml = await readFile(
    new URL('../../.github/workflows/box-sync.yml', import.meta.url),
    'utf8',
  );
  assert.match(yaml, /steps\.plan\.outcome == 'success'[\s\S]*?box-lanes\.mjs run/);
  assert.match(yaml, /steps\.lanes\.outcome == 'success'[\s\S]*?final-check/);
  assert.match(yaml, /steps\.final_check\.outcome == 'success'[\s\S]*?index-update/);
});

test('real child processes reject a malformed plan before producing any receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'box-lanes-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan');
  await mkdir(plan);
  await writeFile(join(plan, 'plan.json'), '{}');
  await assert.rejects(
    runLanes(plan, join(root, 'lanes'), join(root, 'receipts')),
    /all lanes have settled/,
  );
  for (const lane of ['runtime', 'resources', 'downloads'])
    await assert.rejects(readFile(join(root, 'receipts', `${lane}.json`)), { code: 'ENOENT' });
});
