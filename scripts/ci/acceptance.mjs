import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyBrowserEvidence } from './test-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
// Only sharding is accepted: filters must not silently shrink the required lane.
if (args.length > 1 || (args.length && !/^--shard=\d+\/\d+$/.test(args[0]))) {
  throw new Error('acceptance evidence accepts only --shard=N/M');
}
const shard = args[0]?.slice(8).replace('/', '-') ?? 'full';
const outputDir = resolve(root, '.agent-tmp/test-evidence', shard);
mkdirSync(outputDir, { recursive: true });
for (const name of ['actual.json', 'proof.json']) rmSync(resolve(outputDir, name), { force: true });
const cli = resolve(root, 'node_modules/@playwright/test/cli.js');
const base = [cli, 'test', '--config=playwright.acceptance.config.ts'];
const startedAt = new Date().toISOString();
function discover(selection, path) {
  const child = spawnSync(process.execPath, [...base, ...selection, '--list', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  writeFileSync(path, child.stdout ?? '');
  if (child.status !== 0) throw new Error(`discovery failed: ${child.stderr ?? child.error}`);
  return JSON.parse(child.stdout);
}
const full = discover([], resolve(outputDir, 'full.json'));
const selected = args.length ? discover(args, resolve(outputDir, 'selected.json')) : full;
const reportPath = resolve(outputDir, 'actual.json');
const child = spawnSync(process.execPath, [...base, ...args, '--reporter=list,html,json'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    PLAYWRIGHT_HTML_OUTPUT_DIR: resolve(root, 'playwright-acceptance-report'),
  },
});
if (child.status !== 0) process.exit(child.status ?? 1);
const proof = verifyBrowserEvidence(full, selected, JSON.parse(readFileSync(reportPath, 'utf8')));
writeFileSync(
  resolve(outputDir, 'proof.json'),
  JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), ...proof }, null, 2),
);
console.log(
  `Browser identities: ${proof.passed}/${proof.selected} passed, FULL ${proof.full}, zero retries/skips`,
);
