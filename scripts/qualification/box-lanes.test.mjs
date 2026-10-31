import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
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

test('failure joins other lanes and retains successful receipt and earliest recovery', async (t) => {
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
    await mkdir(join(laneRoot, 'receipt'));
    await writeFile(join(laneRoot, 'receipt', `${lane}.json`), lane);
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
  assert.equal(await readFile(join(root, 'receipts', 'resources.json'), 'utf8'), 'resources');
  const summary = JSON.parse(await readFile(join(root, 'lanes', 'orchestration.json')));
  assert.equal(summary.lanes.runtime.status, 'unknown');
  assert.equal(summary.lanes.resources.status, 'success');
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
  assert.match(yaml, /always\(\)[\s\S]*?box-evidence-/);
  assert.match(yaml, /box-plan\/plan\.json/);
  assert.match(yaml, /box-lanes\/orchestration\.json/);
  assert.match(yaml, /box-receipts\/\*\.json/);
  assert.doesNotMatch(yaml, /box-lanes\/\*\*|box-plan\/\*\*/);
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

test(
  'SIGTERM cancels real workers and their signal-resistant descendants before later writes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'box-lanes-cancel-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plan = join(root, 'plan');
    await mkdir(plan);
    await writeFile(join(plan, 'plan.json'), 'plan');
    const descendant = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1]+'/ready-'+process.argv[2],'ready');setTimeout(()=>require('fs').writeFileSync(process.argv[1]+'/late-'+process.argv[2],'bad'),3500);`;
    const worker = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1],process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000);`;
    const helper = join(root, 'parent.mjs');
    await writeFile(
      helper,
      `import {runLanes} from ${JSON.stringify(new URL('./box-lanes.mjs', import.meta.url).href)};await runLanes(${JSON.stringify(plan)},${JSON.stringify(join(root, 'lanes'))},${JSON.stringify(join(root, 'receipts'))},(lane,dir,result,control)=>control.start(process.execPath,['-e',${JSON.stringify(worker)},${JSON.stringify(root)},lane]));`,
    );
    const parent = spawn(process.execPath, [helper], { stdio: 'ignore' });
    const exited = new Promise((resolve) => parent.once('close', resolve));
    const deadline = Date.now() + 5000;
    for (const lane of ['runtime', 'resources', 'downloads']) {
      for (;;) {
        try {
          await readFile(join(root, `ready-${lane}`));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
          await delay(20);
        }
      }
    }
    parent.kill('SIGTERM');
    assert.notEqual(await exited, 0);
    await delay(1800);
    for (const lane of ['runtime', 'resources', 'downloads'])
      await assert.rejects(readFile(join(root, `late-${lane}`)), { code: 'ENOENT' });
    const summary = JSON.parse(await readFile(join(root, 'lanes', 'orchestration.json')));
    assert.equal(summary.cancelled, true);
    assert.equal(summary.lanes.runtime.status, 'unknown');
  },
);
