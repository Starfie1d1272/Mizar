import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');

// Quality owns pure normalization and injected-parser semantics. These consumers
// exercise the host filesystem, localhost transport or child-process boundary.
export function platformTestFiles(platform = process.platform) {
  return [
    'scripts/qualification/product-runtime.test.mjs',
    'scripts/qualification/product-logs.test.mjs',
    'scripts/qualification/supervisor.test.mjs',
    'scripts/qualification/offline.test.mjs',
    'apps/companion/test/capture-recorder.test.ts',
    'apps/companion/test/gsi-capture.integration.test.ts',
    'apps/companion/test/local-web-host.integration.test.ts',
    'apps/companion/test/resource-store/store.test.ts',
    'apps/companion/test/resource-store/app-integration.test.ts',
    'apps/companion/test/local-tournament-store.test.ts',
    'apps/companion/test/hud-config-store.test.ts',
    'apps/companion/test/reliable-outbox.test.ts',
    'apps/companion/test/support-export.test.ts',
    ...(platform === 'win32' ? ['scripts/qualification/gsi-discovery.test.mjs'] : []),
  ];
}

export function verifyPlatformReport(report, files, platform, rootDir = root) {
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0)
    throw new Error('platform contracts runner failed');
  const suites = report.testResults ?? [];
  const actual = suites.map((suite) => relative(rootDir, suite.name).replaceAll('\\', '/'));
  if (
    new Set(actual).size !== files.length ||
    actual.length !== files.length ||
    files.some((file) => !actual.includes(file))
  )
    throw new Error('platform contracts report does not cover the required files exactly once');
  let passed = 0;
  const skips = [];
  for (const suite of suites) {
    const file = relative(rootDir, suite.name).replaceAll('\\', '/');
    const tests = suite.assertionResults ?? [];
    if (!tests.some((test) => test.status === 'passed'))
      throw new Error(`platform contracts file has no passing tests: ${file}`);
    for (const test of tests) {
      if (test.status === 'passed') passed++;
      else if (
        platform === 'win32' &&
        file === 'apps/companion/test/support-export.test.ts' &&
        test.title === 'rejects symlink log targets' &&
        test.fullName === 'support export rejects symlink log targets' &&
        test.status === 'skipped'
      )
        skips.push({ file, title: test.title, reason: 'existing Unix symlink test' });
      else throw new Error(`platform contracts non-passing test: ${file}: ${test.fullName}`);
    }
  }
  return { files: [...files], passed, skips };
}

export async function runPlatformContracts(
  outputDir = resolve(root, '.agent-tmp/platform-evidence'),
) {
  await mkdir(outputDir, { recursive: true });
  const reportPath = resolve(outputDir, 'actual.json');
  const proofPath = resolve(outputDir, 'proof.json');
  await rm(reportPath, { force: true });
  await rm(proofPath, { force: true });
  const files = platformTestFiles();
  const start = performance.now();
  const code = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config=vitest.config.ts',
        ...files,
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
      ],
      { cwd: root, env: process.env, stdio: 'inherit', shell: false },
    );
    child.once('error', reject);
    child.once('exit', done);
  });
  if (code !== 0) throw new Error(`platform contracts exited with ${code}`);
  const proof = verifyPlatformReport(
    JSON.parse(await readFile(reportPath, 'utf8')),
    files,
    process.platform,
  );
  await writeFile(
    proofPath,
    `${JSON.stringify(
      {
        gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        platform: process.platform,
        durationMs: Math.round(performance.now() - start),
        ...proof,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`PLATFORM_CONTRACTS_PASS ${proof.passed} tests in ${files.length} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('platform contracts accepts no filters');
  runPlatformContracts().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
