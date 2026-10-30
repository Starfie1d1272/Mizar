import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export function createBuildTimer(output, identity) {
  const phases = [];
  let pendingWrite = Promise.resolve();
  return async (phase, operation) => {
    const start = performance.now();
    let status = 'success';
    try {
      return await operation();
    } catch (error) {
      status = 'failure';
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      phases.push({ phase, durationMs, status });
      pendingWrite = pendingWrite.then(async () => {
        const path = join(output, 'build-timings.json');
        try {
          await writeFile(path, `${JSON.stringify({ ...identity, phases }, null, 2)}\n`);
        } catch {
          // Never leave a stale partial measurement looking complete.
          await rm(path, { force: true }).catch(() => {});
          console.warn('Build timing unavailable; target remains unverified.');
          return;
        }
        console.log(`BUILD_TIMING ${phase}: ${durationMs} ms (${status})`);
        if (process.env.GITHUB_STEP_SUMMARY) {
          try {
            await appendFile(
              process.env.GITHUB_STEP_SUMMARY,
              `- Build ${phase}: ${(durationMs / 1000).toFixed(2)} s (${status})\n`,
            );
          } catch {
            console.warn('Build timing summary unavailable.');
          }
        }
      });
      await pendingWrite;
    }
  };
}
