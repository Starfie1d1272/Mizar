import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArchitecture } from './check.mjs';

test('production runtime cycles are rejected inside one workspace and type edges do not close a cycle', () => {
  const root = 'apps/companion/src/__cycle_probe__';
  const first = `${root}/first.ts`;
  const second = `${root}/second.ts`;
  const check = (backEdge) =>
    checkArchitecture({
      files: {
        [first]: "export const load = () => import('./second.js');",
        [second]: backEdge,
      },
    }).filter(({ ruleId }) => ruleId === 'ARCH_RUNTIME_MODULE_CYCLE');
  const cycle = check("export { load } from './first.js';");
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].target, `${first} -> ${second} -> ${first}`);
  assert.deepEqual(check("import type { load } from './first.js';"), []);
});
