import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL, pathToFileURL } from 'node:url';

// Independent expectations for commands with distinct read, shutdown and filesystem grants.
const requiredWindows = {
  'preparation-status': ['main', 'tool-connection', 'workspace-dock'],
  'finish-workspace': ['main', 'workspace-dock', 'workspace-left'],
  'save-support-bundle': [
    'main',
    'tool-diagnostics',
    'tool-review',
    'workspace-dock',
    'workspace-left',
  ],
};

export function checkWindowsIpcAcl(capabilities) {
  for (const [command, allowedWindows] of Object.entries(requiredWindows)) {
    const permission = `allow-${command}`;
    const grants = Object.values(capabilities).filter((capability) =>
      capability.permissions.some((value) => (value.identifier ?? value) === permission),
    );
    assert.equal(grants.length, 1, `Unexpected number of actual grants for ${command}`);
    const [grant] = grants;
    assert.deepEqual(
      [...grant.windows].sort(),
      allowedWindows,
      `Unexpected windows for ${command}`,
    );
    assert.deepEqual(grant.webviews ?? [], [], `Unexpected WebView grants for ${command}`);
    assert.deepEqual(
      grant.remote?.urls,
      ['http://127.0.0.1:3000/*'],
      `Unexpected origins for ${command}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const generated =
    process.argv[2] ??
    new URL('../../apps/desktop/src-tauri/gen/schemas/capabilities.json', import.meta.url);
  checkWindowsIpcAcl(JSON.parse(readFileSync(generated, 'utf8')));
  console.log('Windows IPC capability window and origin checks passed.');
}
