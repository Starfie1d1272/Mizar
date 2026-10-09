import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CI_JOB_IDS = Object.freeze([
  'quality',
  'design',
  'acceptance',
  'platform',
  'qualification_offline',
  'qualification_windows',
]);

const DOCS_ONLY_PATTERN = /^(?:docs\/.*|.*\.(?:md|mdx))$/s;
const WEB_BEHAVIOR_SOURCE_PATTERN = /\.(?:ts|tsx|js|jsx|html)$/;
// These producers share browser consumers. Until dependency-aware selection exists,
// route their source changes to the existing complete acceptance lane.
const ACCEPTANCE_SOURCE_PREFIXES = [
  'packages/core/src/',
  'packages/radar/src/',
  'packages/radar-view/src/',
  'packages/hud-config/src/',
  'packages/protocol/src/',
  'packages/telemetry-gsi/src/',
  'apps/companion/src/runtime/',
  'apps/companion/src/projections/',
  'apps/companion/src/program-scenes/',
  'apps/companion/src/local-protocol/',
  'apps/companion/src/hud-config/',
  'apps/companion/src/bp/',
  'apps/companion/src/match-context/',
  'apps/companion/src/series-progress/',
  'apps/companion/src/replay/',
  'apps/companion/src/output/',
];
const KNOWN_QUALITY_PREFIXES = ['apps/', 'packages/', 'tests/', 'scripts/'];
const PLATFORM_PREFIXES = [
  'apps/companion/',
  'packages/telemetry-gsi/',
  'packages/telemetry-cstv/',
];
// Mirror tooling consumes already-qualified release assets; it is not shipped in
// the Desktop payload. Quality owns its identity, authorization and failure
// contracts. Keep this exact allowlist small; other qualification paths retain
// real Windows verification.
const DISTRIBUTION_TOOL_PATHS = new Set([
  'scripts/qualification/box-sync.mjs',
  'scripts/qualification/box-sync.test.mjs',
]);
// Existing Windows consumers own these runtime, portability and installer
// surfaces. Unknown qualification tooling and release-source protocols fail
// closed instead of inheriting the mirror exception.
const WINDOWS_QUALIFICATION_PATHS = new Set([
  'scripts/qualification/bundle/check.ps1',
  'scripts/qualification/bundle/common.ps1',
  'scripts/qualification/bundle/ensure-gsi.ps1',
  'scripts/qualification/bundle/gsi-discovery.ps1',
  'scripts/qualification/bundle/gsi-status.ps1',
  'scripts/qualification/bundle/install-gsi.ps1',
  'scripts/qualification/bundle/mark.ps1',
  'scripts/qualification/bundle/restore-gsi.ps1',
  'scripts/qualification/bundle/rotate.ps1',
  'scripts/qualification/bundle/select-cs2-installation.ps1',
  'scripts/qualification/bundle/start-product.ps1',
  'scripts/qualification/bundle/start.ps1',
  'scripts/qualification/bundle/stop-product.ps1',
  'scripts/qualification/bundle/stop.ps1',
  'scripts/qualification/bundle/update-install.ps1',
  'scripts/qualification/installer-assets/header.bmp',
  'scripts/qualification/installer-assets/header.svg',
  'scripts/qualification/installer-assets/sources.json',
  'scripts/qualification/installer-assets/wizard.bmp',
  'scripts/qualification/installer-assets/wizard.svg',
  'scripts/qualification/offline.mjs',
  'scripts/qualification/offline.test.mjs',
  'scripts/qualification/portable-files.mjs',
  'scripts/qualification/portable-files.test.mjs',
  'scripts/qualification/product-logs.mjs',
  'scripts/qualification/product-logs.test.mjs',
  'scripts/qualification/product-runtime.mjs',
  'scripts/qualification/product-runtime.test.mjs',
  'scripts/qualification/desktop-smoke.mjs',
  'scripts/qualification/desktop-smoke.test.mjs',
  'scripts/qualification/supervisor.mjs',
  'scripts/qualification/supervisor.test.mjs',
  'scripts/qualification/gsi-discovery.test.mjs',
  'scripts/qualification/verify-web-resources.mjs',
  'scripts/qualification/verify-web-resources.test.mjs',
  'scripts/qualification/product-smoke.mjs',
  'scripts/qualification/product-soak.mjs',
  'scripts/qualification/verify-c4-resources.mjs',
  'scripts/qualification/c4-worker-benchmark.mjs',
  'scripts/qualification/create-windows-archive.ps1',
  'scripts/qualification/create-windows-setup.ps1',
  'scripts/qualification/capture-setup-ui.ps1',
  'scripts/qualification/desktop-probe.ps1',
  'scripts/qualification/extract-windows-shell.ps1',
  'scripts/qualification/windows-setup.nsi',
]);

const PORTABLE_SMOKE_PREFIXES = ['scripts/qualification/', 'apps/desktop/'];

export function isPortableSmokePath(path) {
  if (DISTRIBUTION_TOOL_PATHS.has(path)) return false;
  return (
    PORTABLE_SMOKE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path === 'packages/telemetry-gsi/src/production-config.json' ||
    path === 'apps/companion/src/qualification/contract.json' ||
    path === 'scripts/qualification/build.mjs' ||
    path === 'scripts/qualification/product-runtime.mjs' ||
    path === 'scripts/qualification/product-smoke.mjs' ||
    path === 'scripts/qualification/supervisor.mjs' ||
    /(?:^|\/)gamestate_integration[^/]*\.cfg(?:\.template)?$/.test(path)
  );
}

function normalizePath(path) {
  return typeof path === 'string' ? path.replaceAll('\\', '/').replace(/^\.\//, '') : '';
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isForcedFullPath(path) {
  const name = basename(path);
  return (
    (!isDocsOnlyPath(path) && path.startsWith('apps/companion/src/updates/')) ||
    (!isDocsOnlyPath(path) &&
      path.startsWith('scripts/qualification/') &&
      !DISTRIBUTION_TOOL_PATHS.has(path) &&
      !WINDOWS_QUALIFICATION_PATHS.has(path)) ||
    path.startsWith('.github/') ||
    path.startsWith('scripts/ci/') ||
    name === 'package.json' ||
    path === 'pnpm-lock.yaml' ||
    path === 'pnpm-workspace.yaml' ||
    name.startsWith('tsconfig') ||
    name.startsWith('eslint.config.') ||
    name.startsWith('vitest.config.') ||
    name.startsWith('playwright.config.') ||
    (name.startsWith('playwright.') && name.endsWith('.config.ts'))
  );
}

export function isDesignPath(path) {
  return (
    [
      'packages/design-tokens/',
      'docs/design/',
      'apps/web/src/ui/',
      'apps/web/src/patterns/',
      'apps/web/.storybook/',
      'apps/web/test/design/',
      'scripts/design/',
      'scripts/architecture/',
    ].some((prefix) => path.startsWith(prefix)) || /\.stories\.[^.]+$/.test(path)
  );
}

function isDocsOnlyPath(path) {
  return DOCS_ONLY_PATTERN.test(path);
}

function isKnownQualityPath(path) {
  return (
    KNOWN_QUALITY_PREFIXES.some((prefix) => path.startsWith(prefix)) || isQualificationPath(path)
  );
}

function isAcceptancePath(path) {
  return (
    (path.startsWith('apps/web/') && WEB_BEHAVIOR_SOURCE_PATTERN.test(path)) ||
    path.startsWith('tests/acceptance/') ||
    path.startsWith('packages/replay/') ||
    (!isDocsOnlyPath(path) &&
      !path.endsWith('.css') &&
      ACCEPTANCE_SOURCE_PREFIXES.some((prefix) => path.startsWith(prefix))) ||
    path === 'apps/companion/src/app.ts' ||
    path === 'apps/companion/src/server.ts' ||
    path.startsWith('scripts/local-web-production') ||
    path.includes('program-fixtures/')
  );
}

function isPlatformPath(path) {
  return PLATFORM_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isQualificationPath(path) {
  return isPortableSmokePath(path);
}

function isUnsafeChangeStatus(status) {
  return !/^(?:[AMD]|R(?:100|0[0-9]{2}|[0-9]{1,2}))$/.test(status ?? '');
}

function fullPlan(reason, includeOfflineQualification = false) {
  return {
    runQuality: true,
    runDesign: true,
    runAcceptance: true,
    runPlatform: true,
    runQualification: true,
    runOfflineQualification: includeOfflineQualification,
    requiredJobs: CI_JOB_IDS.filter(
      (job) => includeOfflineQualification || job !== 'qualification_offline',
    ),
    reason,
  };
}

function selectivePlan(changedFiles, eventName) {
  const runDesign = changedFiles.some(({ path }) => isDesignPath(path));
  const runQuality = changedFiles.some(({ path }) => isKnownQualityPath(path));
  const runAcceptance = changedFiles.some(({ path }) => isAcceptancePath(path));
  const runPlatform = changedFiles.some(({ path }) => isPlatformPath(path));
  const runQualification = changedFiles.some(({ path }) => isQualificationPath(path));
  const requiredJobs = CI_JOB_IDS.filter((job) => {
    if (job === 'quality') return runQuality;
    if (job === 'design') return runDesign;
    if (job === 'acceptance') return runAcceptance;
    if (job === 'platform') return runPlatform;
    if (job === 'qualification_offline') return false;
    return runQualification;
  });

  return {
    runQuality,
    runDesign,
    runAcceptance,
    runPlatform,
    runQualification,
    runOfflineQualification: false,
    requiredJobs,
    reason: `${eventName} changed surface classified (${changedFiles.length} file(s))`,
  };
}

/** @typedef {{ path: string, status?: string }} ChangedFile */

/**
 * Parse name-status records. Deleted paths and both sides of a rename retain
 * their classification; malformed records fail closed. CI uses -z so Unicode,
 * whitespace and quoted Git paths are never mistaken for unknown paths.
 *
 * @param {string} output
 * @returns {ChangedFile[]}
 */
export function parseGitDiffNameStatus(output) {
  const changedFiles = [];
  const add = (status, paths) => {
    const expected = status.startsWith('R') ? 2 : 1;
    if (isUnsafeChangeStatus(status) || paths.length !== expected || paths.some((p) => !p)) {
      changedFiles.push({ path: '', status: 'X' });
      return;
    }
    for (const path of paths) changedFiles.push({ path: normalizePath(path), status });
  };
  if (output.includes('\0')) {
    const fields = output.split('\0');
    if (fields.pop() !== '') return [{ path: '', status: 'X' }];
    for (let i = 0; i < fields.length;) {
      const status = fields[i++];
      const count = status.startsWith('R') ? 2 : 1;
      add(status, fields.slice(i, i + count));
      i += count;
    }
  } else {
    for (const line of output.split(/\r?\n/)) {
      if (line === '') continue;
      const [status, ...paths] = line.split('\t');
      // Non-NUL Git output may C-quote paths. Never classify such an escape.
      add(status, paths.some((path) => path.startsWith('"')) ? [] : paths);
    }
  }
  return changedFiles;
}

/**
 * @param {{ eventName?: string, changedFiles?: Array<ChangedFile | string> }} [options]
 */
export function createCiPlan(options = {}) {
  const eventName = options.eventName ?? 'pull_request';
  if (!['pull_request', 'push'].includes(eventName))
    return fullPlan(`forced full for ${eventName}`, true);
  const includeOfflineQualification = eventName === 'push';

  const changedFiles = (options.changedFiles ?? []).map((entry) =>
    typeof entry === 'string'
      ? { path: normalizePath(entry), status: 'M' }
      : { path: normalizePath(entry.path), status: entry.status ?? 'M' },
  );

  if (changedFiles.length === 0)
    return fullPlan(`forced full: missing ${eventName} changed paths`, includeOfflineQualification);
  if (
    changedFiles.some(
      ({ path, status }) => path === '' || isUnsafeChangeStatus(status) || isForcedFullPath(path),
    )
  ) {
    return fullPlan(
      'forced full: unsafe, toolchain, workflow, or planner change',
      includeOfflineQualification,
    );
  }
  if (changedFiles.every(({ path }) => isDocsOnlyPath(path) && !isDesignPath(path))) {
    return {
      runQuality: false,
      runDesign: false,
      runAcceptance: false,
      runPlatform: false,
      runQualification: false,
      runOfflineQualification: false,
      requiredJobs: [],
      reason: 'docs-only change',
    };
  }

  const plan = selectivePlan(changedFiles, eventName);
  if (!isKnownQualityPathForAll(changedFiles)) {
    return fullPlan('forced full: unknown or unclassified path', includeOfflineQualification);
  }
  return plan;
}

function isKnownQualityPathForAll(changedFiles) {
  return changedFiles.every(({ path }) => isDocsOnlyPath(path) || isKnownQualityPath(path));
}

/**
 * @param {{ planResult?: string, requiredJobs: unknown, jobResults: Record<string, unknown> }} input
 */
export function evaluateCiGate(input) {
  const failures = [];
  if (input.planResult !== 'success') failures.push(`plan=${input.planResult ?? 'missing'}`);

  if (!Array.isArray(input.requiredJobs)) {
    failures.push('required_jobs=invalid');
  } else {
    for (const job of input.requiredJobs) {
      if (!CI_JOB_IDS.includes(job)) {
        failures.push(`required_job=${String(job)}`);
        continue;
      }
      const result = input.jobResults[job];
      if (result !== 'success') failures.push(`${job}=${result ?? 'missing'}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

function outputPlan(plan) {
  return {
    run_quality: String(plan.runQuality),
    run_design: String(plan.runDesign),
    run_acceptance: String(plan.runAcceptance),
    run_platform: String(plan.runPlatform),
    run_qualification: String(plan.runQualification),
    run_offline_qualification: String(plan.runOfflineQualification),
    required_jobs: JSON.stringify(plan.requiredJobs),
    reason: plan.reason,
  };
}

function runPlanner() {
  const changedFiles = process.env.CHANGED_FILES_FILE
    ? parseGitDiffNameStatus(readFileSync(process.env.CHANGED_FILES_FILE, 'utf8'))
    : [];
  const plan = createCiPlan({ eventName: process.env.GITHUB_EVENT_NAME, changedFiles });
  const outputs = outputPlan(plan);
  const output = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  console.log(JSON.stringify(plan));
}

function runGate() {
  let requiredJobs;
  try {
    requiredJobs = JSON.parse(process.env.REQUIRED_JOBS ?? 'null');
  } catch {
    requiredJobs = null;
  }
  const result = evaluateCiGate({
    planResult: process.env.PLAN_RESULT,
    requiredJobs,
    jobResults: {
      quality: process.env.QUALITY_RESULT,
      design: process.env.DESIGN_RESULT,
      acceptance: process.env.ACCEPTANCE_RESULT,
      platform: process.env.PLATFORM_RESULT,
      qualification_offline: process.env.QUALIFICATION_OFFLINE_RESULT,
      qualification_windows: process.env.QUALIFICATION_WINDOWS_RESULT,
    },
  });
  if (!result.ok) {
    console.error(`ci-gate failed: ${result.failures.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('ci-gate passed: all planner-selected jobs succeeded');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--gate')) runGate();
  else runPlanner();
}
