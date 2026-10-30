import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoxPlan,
  readBoxPlan,
  makeBoxReceipt,
  assertBoxReceipt,
} from './box-phase-contract.mjs';

const item = (name) => ({ name, size: 7, sha256: 'a'.repeat(64) });
const input = () => ({
  runId: '123',
  attempt: 1,
  tag: 'v1.10.0',
  releaseId: 7,
  sourceSha: 'b'.repeat(40),
  coreArchiveSha: 'd'.repeat(64),
  assets: {
    runtime: [item('machine-metadata.json'), item('Mizar-v1.10.0-Windows-x64-Core-Setup.exe')],
    resources: [item('Mizar-official-epl-default-1.0.0.zip')],
    downloads: [item('Mizar-v1.10.0-Windows-x64-WebInstaller.exe')],
  },
  updateIndex: item('update-index.json'),
});

test('receipts bind the exact plan, run, attempt, lane and assets', () => {
  const bytes = createBoxPlan(input());
  const plan = readBoxPlan(bytes);
  const receipt = makeBoxReceipt(bytes, 'runtime', '123', 2, plan.assets.runtime);
  assert.equal(assertBoxReceipt(bytes, receipt, 'runtime', '123', 2).attempt, 2);
  assert.throws(() => assertBoxReceipt(bytes, receipt, 'resources', '123', 2));
  assert.throws(() => assertBoxReceipt(bytes, receipt, 'runtime', '124', 2));
  assert.throws(() => assertBoxReceipt(bytes, receipt, 'runtime', '123', 1));
  const changed = input();
  changed.assets.runtime[0].sha256 = 'c'.repeat(64);
  assert.throws(() => assertBoxReceipt(createBoxPlan(changed), receipt, 'runtime', '123', 2));
  assert.throws(() => makeBoxReceipt(bytes, 'runtime', '123', 2, changed.assets.runtime));
  assert.throws(() => readBoxPlan(Buffer.concat([bytes, Buffer.from(' ')])));
});

test('duplicate names and unsafe paths are rejected', () => {
  const duplicate = input();
  duplicate.assets.resources = duplicate.assets.runtime;
  assert.throws(() => createBoxPlan(duplicate));
  const unsafe = input();
  unsafe.assets.runtime[0].name = '../core.exe';
  assert.throws(() => createBoxPlan(unsafe));
});
