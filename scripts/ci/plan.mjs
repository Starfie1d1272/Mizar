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
const KNOWN_QUALITY_PREFIXES = ['apps/', 'packages/', 'tests/', 'scripts/'];
const PLATFORM_PREFIXES = [
  'apps/companion/',
  'packages/telemetry-gsi/',
  'packages/telemetry-cstv/',
];
const PORTABLE_SMOKE_PREFIXES = ['scripts/qualification/bundle/', 'apps/desktop/'];

export function isPortableSmokePath(path) {
  return (
    PORTABLE_SMOKE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
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
    path === 'packages/protocol/src/program.ts' ||
    path === 'packages/protocol/src/version.ts' ||
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
