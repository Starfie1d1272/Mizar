import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArchitecture } from './check.mjs';
import { checkWindowsIpcAcl } from './windows-ipc-acl.mjs';

test('the generated IPC capability check rejects wrong-window and missing-window grants', () => {
  const capability = (command, windows) => ({
    permissions: [`allow-${command}`],
    windows,
    remote: { urls: ['http://127.0.0.1:3000/*'] },
  });
  const capabilities = {
    read: capability('preparation-status', ['main', 'workspace-dock', 'tool-connection']),
    exit: capability('finish-workspace', ['main', 'workspace-dock', 'workspace-left']),
    save: capability('save-support-bundle', [
      'main',
      'tool-diagnostics',
      'tool-review',
      'workspace-left',
      'workspace-dock',
    ]),
  };
  checkWindowsIpcAcl(capabilities);
  capabilities.exit.windows.push('tool-connection');
  assert.throws(() => checkWindowsIpcAcl(capabilities), /Unexpected windows for finish-workspace/);
  capabilities.exit.windows.pop();
  capabilities.read.windows.pop();
  assert.throws(
    () => checkWindowsIpcAcl(capabilities),
    /Unexpected windows for preparation-status/,
  );
});

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
