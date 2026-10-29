import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, writeFile } from 'node:fs/promises';

// Both artifacts belong to the already validated run. Distinct destinations avoid races.
// Join failures before returning so a failed transfer cannot leave a live downloader.
export async function downloadQualifiedArtifacts(
  runId,
  execute = promisify(execFile),
  resourceRoot,
) {
  if (!/^\d+$/.test(runId)) throw new Error('Invalid qualification run ID');
  if (resourceRoot) await rm(`${resourceRoot}.download-failed`, { force: true });
  const results = await Promise.allSettled(
    [
      ['release-portable-product', 'product'],
      ['release-qualification-evidence', 'evidence'],
      ...(resourceRoot ? [['release-qualified-resources', resourceRoot]] : []),
    ].map(([name, directory]) =>
      execute('gh', ['run', 'download', runId, '--name', name, '--dir', directory], {
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }),
    ),
  );
  const failed = results.slice(0, 2).find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  // Older qualifications can predate resource artifacts. The caller checks this
  // marker only after identifying whether its source requires those resources.
  if (resourceRoot && results[2].status === 'rejected')
    await writeFile(`${resourceRoot}.download-failed`, 'Resource artifact download failed\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await downloadQualifiedArtifacts(process.argv[2] ?? '', undefined, process.argv[3]);
}
