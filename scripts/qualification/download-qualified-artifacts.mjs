import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both artifacts belong to the already validated run. Distinct destinations avoid races.
// Join failures before returning so a failed transfer cannot leave a live downloader.
export async function downloadQualifiedArtifacts(runId, execute = promisify(execFile)) {
  if (!/^\d+$/.test(runId)) throw new Error('Invalid qualification run ID');
  const results = await Promise.allSettled(
    [
      ['release-portable-product', 'product'],
      ['release-qualification-evidence', 'evidence'],
    ].map(([name, directory]) =>
      execute('gh', ['run', 'download', runId, '--name', name, '--dir', directory], {
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }),
    ),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await downloadQualifiedArtifacts(process.argv[2] ?? '');
}
