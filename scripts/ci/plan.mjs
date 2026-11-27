import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DOC_ONLY_FILES = new Set([
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
]);

const DOC_ONLY_PREFIXES = ['docs/', '.github/ISSUE_TEMPLATE/'];

const NATIVE_RUST_PATHS = [
  'apps/desktop/src-tauri',
  'apps/desktop/installer',
  'packages/protocol/src/desktop-ipc.generated.ts',
  'apps/companion/src/match-context/lifecycle-contract.json',
  'scripts/qualification/bundle/gsi-discovery.ps1',
  'config/mizar_observer.cfg',
  'scripts/ci/cargo-cache-key.mjs',
  'scripts/architecture/windows-ipc-acl.mjs',
  '.cargo',
  'rust-toolchain',
  'rust-toolchain.toml',
  '.github/actions/cargo-cache',
  '.github/actions/save-cargo-cache',
  '.github/workflows/ci.yml',
  'scripts/ci/plan.mjs',
];

const WEB_INSTALLER_PATHS = [
  'scripts/web-installer',
  'config/distribution.json',
  '.github/workflows/ci.yml',
  'scripts/ci/plan.mjs',
];

function isDocOnlyPath(file) {
  return DOC_ONLY_FILES.has(file) || DOC_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function matchesAnyPath(file, paths) {
  return paths.some((target) => file === target || file.startsWith(`${target}/`));
}

export function planFromChangedFiles(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { run_build: true, run_native_rust: true, run_web_installer: true };
  }
  return {
    run_build: !changedFiles.every(isDocOnlyPath),
    run_native_rust: changedFiles.some((file) => matchesAnyPath(file, NATIVE_RUST_PATHS)),
    run_web_installer: changedFiles.some((file) => matchesAnyPath(file, WEB_INSTALLER_PATHS)),
  };
}

export function computeCiPlan({
  eventName = process.env.GITHUB_EVENT_NAME,
  prBase = process.env.PR_BASE,
  sha = process.env.GITHUB_SHA,
  diff = (base, head) =>
    execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' }),
} = {}) {
  if (eventName !== 'pull_request' || !prBase || !sha) {
    return { run_build: true, run_native_rust: true, run_web_installer: true };
  }
  try {
    const files = diff(prBase, sha)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return planFromChangedFiles(files);
  } catch {
    return { run_build: true, run_native_rust: true, run_web_installer: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = computeCiPlan();
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `run_build=${plan.run_build}\nrun_native_rust=${plan.run_native_rust}\nrun_web_installer=${plan.run_web_installer}\n`,
  );
  console.log(
    `CI plan: build=${plan.run_build}, native_rust=${plan.run_native_rust}, web_installer=${plan.run_web_installer}`,
  );
}
