import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCiPlan, planFromChangedFiles } from './plan.mjs';

test('non-pull_request or missing diff falls back to running everything', () => {
  assert.deepEqual(computeCiPlan({ eventName: 'push' }), {
    run_build: true,
    run_native_rust: true,
    run_web_installer: true,
  });
  assert.deepEqual(
    computeCiPlan({
      eventName: 'pull_request',
      prBase: 'a'.repeat(40),
      sha: 'b'.repeat(40),
      diff: () => {
        throw new Error('git failed');
      },
    }),
    { run_build: true, run_native_rust: true, run_web_installer: true },
  );
});

test('pure repository docs skip build and native while product docs/assets still run build', () => {
  assert.deepEqual(
    planFromChangedFiles(['docs/guide/quick-start.md', 'CHANGELOG.md', 'README.md']),
    {
      run_build: false,
      run_native_rust: false,
      run_web_installer: false,
    },
  );
  assert.deepEqual(planFromChangedFiles(['apps/web/README.md']), {
    run_build: true,
    run_native_rust: false,
    run_web_installer: false,
  });
});

test('native rust and web installer paths trigger independently, and plan.mjs triggers both', () => {
  assert.deepEqual(planFromChangedFiles(['apps/desktop/src-tauri/src/lib.rs']), {
    run_build: true,
    run_native_rust: true,
    run_web_installer: false,
  });
  assert.deepEqual(planFromChangedFiles(['scripts/web-installer/Program.cs']), {
    run_build: true,
    run_native_rust: false,
    run_web_installer: true,
  });
  assert.deepEqual(planFromChangedFiles(['scripts/ci/plan.mjs']), {
    run_build: true,
    run_native_rust: true,
    run_web_installer: true,
  });
});

test('renaming a file out of a native directory still triggers native_rust via --no-renames', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-plan-rename-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(join(dir, 'apps/desktop/src-tauri'), { recursive: true });
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'apps/desktop/src-tauri/notes.txt'), 'same content across rename\n');
  git('add', '.');
  git('commit', '-m', 'init');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'apps/desktop/src-tauri/notes.txt', 'docs/notes.txt');
  git('commit', '-m', 'move out of native');
  const head = git('rev-parse', 'HEAD');

  const plan = computeCiPlan({
    eventName: 'pull_request',
    prBase: base,
    sha: head,
    cwd: dir,
  });
  assert.deepEqual(plan, {
    run_build: true,
    run_native_rust: true,
    run_web_installer: false,
  });
});
