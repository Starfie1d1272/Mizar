import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

test('production recovery functions preserve later installations and recovery owners', () => {
  // GitHub's Ubuntu runner supplies PowerShell. Only isolated function fixtures
  // execute here; real Windows installation remains a separate acceptance step.
  execFileSync(
    process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./check-update-ownership.ps1', import.meta.url)),
    ],
    { stdio: 'inherit', timeout: 30000 },
  );
});
