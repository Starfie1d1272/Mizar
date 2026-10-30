import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One gh operation per process. A failed or timed-out write is never replayed here;
// the release reconciliation path must first inspect and verify the remote bytes.
export function runBoundedGh(args, execute = execFileSync) {
  if (!args.length || !['api', 'release', 'attestation', 'run'].includes(args[0]))
    throw new Error('Invalid bounded gh operation');
  const started = globalThis.performance.now();
  const operation = args[0];
  console.error(`GH ${operation} start attempt=1 deadline_ms=180000`);
  try {
    execute('gh', args, { stdio: 'inherit', timeout: 180000, windowsHide: true });
    console.error(
      `GH ${operation} success elapsed_ms=${Math.round(globalThis.performance.now() - started)}`,
    );
  } catch (error) {
    const kind =
      error?.code === 'ETIMEDOUT'
        ? 'timeout'
        : `exit_${Number.isInteger(error?.status) ? error.status : 'unknown'}`;
    console.error(
      `GH ${operation} failure elapsed_ms=${Math.round(globalThis.performance.now() - started)} reason=${kind}; remote writes require reconciliation`,
    );
    // Do not preserve raw gh errors: they can contain signed URLs or credentials.
    // eslint-disable-next-line preserve-caught-error -- Raw gh errors may contain credentials or signed URLs.
    throw new Error(`GH ${operation} failed or timed out`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runBoundedGh(process.argv.slice(2));
  } catch {
    process.exitCode = 1;
  }
}
