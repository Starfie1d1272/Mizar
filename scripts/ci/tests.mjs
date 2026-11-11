import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const group = process.argv[2];
if (!['scripts', 'product'].includes(group)) {
  throw new Error('Usage: node scripts/ci/tests.mjs <scripts|product>');
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
const nodeFiles = [];
const vitestFiles = [];
for (const file of files) {
  const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const node = /from\s*['"]node:test['"]/.test(source);
  const vitest = /from\s*['"]vitest['"]/.test(source);
  if (node === vitest) throw new Error(`Test must select exactly one runner: ${file}`);
  if (file.startsWith('scripts/') !== (group === 'scripts')) continue;
  (node ? nodeFiles : vitestFiles).push(file);
}
if (!nodeFiles.length && !vitestFiles.length) throw new Error(`No tests found for ${group}`);
console.log(`CI ${group}: ${nodeFiles.length} Node tests, ${vitestFiles.length} Vitest tests`);

if (nodeFiles.length) {
  const args = [];
  if (nodeFiles.some((file) => /\.[cm]?tsx?$/.test(file))) {
    const require = createRequire(new URL('../../apps/companion/package.json', import.meta.url));
    args.push('--import', require.resolve('tsx'));
  }
  execFileSync(process.execPath, [...args, '--test', ...nodeFiles], {
    cwd: root,
    stdio: 'inherit',
  });
}
if (vitestFiles.length) {
  const { startVitest } = await import('vitest/node');
  const ctx = await startVitest(
    'test',
    [],
    { root, config: false, watch: false, include: vitestFiles, exclude: [], maxWorkers: 4 },
    { oxc: { jsx: { runtime: 'automatic' } } },
  );
  if (!ctx) throw new Error('Vitest did not start');
  await ctx.close();
}
