import { spawnSync } from 'node:child_process';
import { stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.platform !== 'win32') throw new Error('Desktop benchmark requires Windows');
const root = resolve(import.meta.dirname, '../..');
const source = resolve(root, 'apps/desktop/src-tauri/src/main.rs');
const original = await stat(source);
const measurements = [];
async function measure(name, overrides) {
  // Only timestamps change: both profiles rebuild the same Desktop source.
  await utimes(source, new Date(), new Date());
  const start = performance.now();
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--locked',
      '--profile',
      'ci',
      '--manifest-path',
      'apps/desktop/src-tauri/Cargo.toml',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...overrides },
    },
  );
  measurements.push({
    name,
    seconds: (performance.now() - start) / 1000,
    exitCode: result.status,
    overrides,
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`Benchmark failed: ${name}`);
}
try {
  await measure('no-embed-opt1-host-rebuild', {});
  const candidate = {
    CARGO_PROFILE_CI_OPT_LEVEL: '0',
    CARGO_PROFILE_CI_INCREMENTAL: 'true',
    CARGO_PROFILE_CI_CODEGEN_UNITS: '256',
  };
  await measure('opt0-first-build', candidate);
  await measure('opt0-host-rebuild', candidate);
} finally {
  await utimes(source, original.atime, original.mtime);
  await writeFile(
    resolve(process.env.QUALIFICATION_BUILD_ROOT, 'cargo-benchmark.json'),
    `${JSON.stringify({ gitSha: process.env.GITHUB_SHA, measurements }, null, 2)}\n`,
  );
}
