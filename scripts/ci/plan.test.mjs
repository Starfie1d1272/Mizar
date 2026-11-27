import test from 'node:test';
import assert from 'node:assert/strict';
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
