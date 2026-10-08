import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export function createBuildTimer(output, identity) {
  const phases = [];
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
      await writeFile(
        join(output, 'build-timings.json'),
        `${JSON.stringify({ ...identity, phases }, null, 2)}\n`,
      );
      console.log(`BUILD_TIMING ${phase}: ${durationMs} ms (${status})`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `- Build ${phase}: ${(durationMs / 1000).toFixed(2)} s (${status})\n`,
        );
      }
    }
  };
}
