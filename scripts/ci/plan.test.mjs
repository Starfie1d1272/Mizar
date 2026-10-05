import { describe, expect, it } from 'vitest';

import { createCiPlan, evaluateCiGate, parseGitDiffNameStatus } from './plan.mjs';

const full = {
  runQuality: true,
  runAcceptance: true,
  runPlatform: true,
  runQualification: true,
};

describe('changed-surface CI planner', () => {
  it('parses ordinary and rename diff records', () => {
    expect(parseGitDiffNameStatus('M\tpackages/core/src/index.ts\nR100\told.ts\tnew.ts\n')).toEqual(
      [
        { path: 'packages/core/src/index.ts', status: 'M' },
        { path: 'old.ts', status: 'R100' },
        { path: 'new.ts', status: 'R100' },
      ],
    );
  });

  it.each([
    [
      'docs-only',
      ['docs/product.md', 'README.md', 'THIRD-PARTY-NOTICES.md'],
      {
        runQuality: false,
        runAcceptance: false,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'web HUD/CSS only',
      ['apps/web/src/program/program.css'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'web HUD behavior',
      ['apps/web/src/program/widgets/player-rails/PlayerCard.tsx'],
      {
        runQuality: true,
        runAcceptance: true,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'core projection',
      ['packages/core/src/projection/program.ts'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'radar geometry',
      ['packages/radar/src/map-geometry.ts'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'companion runtime',
      ['apps/companion/src/runtime/program-runtime.ts'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: true,
        runQualification: false,
      },
    ],
    [
      'telemetry adapter',
      ['packages/telemetry-gsi/src/adapter.ts'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: true,
        runQualification: false,
      },
    ],
    [
      'qualification verifier only',
      ['scripts/qualification/offline.mjs'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'portable bundle script',
      ['scripts/qualification/bundle/start.ps1'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: true,
      },
    ],
    [
      'Tauri desktop host',
      ['apps/desktop/src-tauri/src/main.rs'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: true,
      },
    ],
    [
      'portable product runtime',
      ['scripts/qualification/product-runtime.mjs'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: true,
      },
    ],
    [
      'GSI config template',
      ['config/gamestate_integration_mizar.cfg.template'],
      {
        runQuality: true,
        runAcceptance: false,
        runPlatform: false,
        runQualification: true,
      },
    ],
  ])('%s selects the matching evidence', (_name, files, expected) => {
    const plan = createCiPlan({ eventName: 'pull_request', changedFiles: files });
    expect(plan).toMatchObject(expected);
    expect(plan.requiredJobs).not.toContain('qualification_offline');
    expect(plan.runOfflineQualification).toBe(false);
  });

  it.each([
    ['package config', ['packages/core/package.json']],
    ['lockfile', ['pnpm-lock.yaml']],
    ['workspace config', ['pnpm-workspace.yaml']],
    ['toolchain config', ['tsconfig.json']],
    ['acceptance Playwright config', ['playwright.acceptance.config.ts']],
    ['workflow', ['.github/workflows/ci.yml']],
    ['planner self-change', ['scripts/ci/plan.mjs']],
    ['unknown path', ['fixtures/custom-input.json']],
    ['type change', [{ path: 'packages/core/src/old.ts', status: 'T' }]],
  ])('%s fails closed to full CI', (_name, changedFiles) => {
    expect(createCiPlan({ eventName: 'pull_request', changedFiles })).toMatchObject(full);
  });

  it('runs full validation on main pushes', () => {
    const plan = createCiPlan({ eventName: 'push', changedFiles: ['README.md'] });
    expect(plan).toMatchObject(full);
    expect(plan.runOfflineQualification).toBe(true);
  });

  it.each([
    ['D\tdocs/old.md\n', []],
    ['R100\tdocs/old.md\tdocs/archive/new.md\n', []],
    ['R096\tdocs/design/old.md\tdocs/archive/old.md\n', ['design']],
    ['R80\tdocs/old.md\tapps/web/src/new.ts\n', ['quality', 'acceptance']],
    [
      'R100\tapps/desktop/src-tauri/src/old.rs\tdocs/archive/old.md\n',
      ['quality', 'qualification_windows'],
    ],
    ['D\tapps/companion/src/output/service.ts\n', ['quality', 'platform']],
  ])('classifies delete/rename risk union: %s', (diff, requiredJobs) => {
    expect(createCiPlan({ changedFiles: parseGitDiffNameStatus(diff) }).requiredJobs).toEqual(
      requiredJobs,
    );
  });

  it('parses Unicode and whitespace paths from NUL-delimited Git output', () => {
    expect(
      createCiPlan({
        changedFiles: parseGitDiffNameStatus(
          'R100\0docs/旧 文件.md\0docs/archive/新\n文件.md\0D\0docs/old.png\0',
        ),
      }).requiredJobs,
    ).toEqual([]);
  });

  it.each([
    'R100\tdocs/old.md\n',
    'R101\tdocs/old.md\tdocs/new.md\n',
    'M\tdocs/a.md\tdocs/b.md\n',
    'D\0',
    'M\0docs/a.md',
    'M\t"docs/quoted.md"\n',
    'T\tdocs/a.md\n',
    'R100\tdocs/a.md\tunknown.file\n',
    'R100\t.github/workflows/ci.yml\tdocs/archive/ci.md\n',
  ])('fails closed for malformed, unknown or high-risk diff: %s', (diff) => {
    expect(createCiPlan({ changedFiles: parseGitDiffNameStatus(diff) })).toMatchObject(full);
  });

  it.each([
    ['desktop Cargo profile', 'apps/desktop/src-tauri/Cargo.toml'],
    ['qualification builder', 'scripts/qualification/build.mjs'],
  ])('requires Windows qualification for %s changes on main push', (_name, path) => {
    const plan = createCiPlan({
      eventName: 'push',
      changedFiles: [path],
    });
    expect(plan.runQualification).toBe(true);
    expect(plan.requiredJobs).toContain('qualification_windows');
  });

  it.each([
    ['branch creation with an empty diff', []],
    ['all-zero before sentinel', [{ path: '', status: 'X' }]],
    ['rename', [{ path: 'apps/web/src/old.ts', status: 'R100' }]],
    ['delete', [{ path: 'apps/desktop/src-tauri/src/old.rs', status: 'D' }]],
  ])('main push %s fails closed to full CI', (_name, changedFiles) => {
    const plan = createCiPlan({ eventName: 'push', changedFiles });
    expect(plan).toMatchObject(full);
    expect(plan.requiredJobs).toContain('qualification_offline');
    expect(plan.runOfflineQualification).toBe(true);
  });

  it.each(['schedule', 'workflow_dispatch'])('%s forces full CI', (eventName) => {
    const plan = createCiPlan({ eventName, changedFiles: ['docs/product.md'] });
    expect(plan).toMatchObject(full);
    expect(plan.requiredJobs).toContain('qualification_offline');
    expect(plan.runOfflineQualification).toBe(true);
  });

  it('keeps offline qualification out of ordinary PR full CI', () => {
    const plan = createCiPlan({
      eventName: 'pull_request',
      changedFiles: ['.github/workflows/ci.yml'],
    });
    expect(plan.requiredJobs).not.toContain('qualification_offline');
    expect(plan.runOfflineQualification).toBe(false);
  });
});

describe('CI gate selection', () => {
  it('accepts skipped unselected jobs for docs-only changes', () => {
    expect(
      evaluateCiGate({
        planResult: 'success',
        requiredJobs: [],
        jobResults: {
          quality: 'skipped',
          acceptance: 'skipped',
          platform: 'skipped',
          qualification_offline: 'skipped',
          qualification_windows: 'skipped',
        },
      }),
    ).toEqual({ ok: true, failures: [] });
  });

  it('requires every selected job to succeed', () => {
    expect(
      evaluateCiGate({
        planResult: 'success',
        requiredJobs: ['quality', 'acceptance'],
        jobResults: { quality: 'success', acceptance: 'skipped' },
      }),
    ).toEqual({ ok: false, failures: ['acceptance=skipped'] });
  });

  it('fails when the planner fails or emits an invalid selection', () => {
    expect(
      evaluateCiGate({
        planResult: 'failure',
        requiredJobs: [],
        jobResults: {},
      }),
    ).toEqual({ ok: false, failures: ['plan=failure'] });
    expect(
      evaluateCiGate({
        planResult: 'success',
        requiredJobs: ['unexpected'],
        jobResults: {},
      }),
    ).toEqual({ ok: false, failures: ['required_job=unexpected'] });
  });
});

describe('Design targeted lane', () => {
  it.each([
    'packages/design-tokens/src/base.tokens.json',
    'docs/design/brand.md',
    'apps/web/src/ui/ui.css',
    'apps/web/src/patterns/workbench.stories.tsx',
    'apps/web/.storybook/main.ts',
  ])('selects design without Windows qualification for %s', (path) => {
    const plan = createCiPlan({ changedFiles: [path] });
    expect(plan.runDesign).toBe(true);
    expect(plan.requiredJobs).toContain('design');
    expect(plan.runQualification).toBe(false);
    expect(plan.runPlatform).toBe(false);
  });
  it('does not run catalog for an ordinary Runtime change', () => {
    expect(createCiPlan({ changedFiles: ['packages/core/src/runtime.ts'] }).runDesign).toBe(false);
  });
  it('includes design when planner/workflow forces full CI', () => {
    expect(createCiPlan({ changedFiles: ['scripts/ci/plan.mjs'] }).requiredJobs).toContain(
      'design',
    );
  });
  it('fails ci-gate if selected design is skipped or fails', () => {
    expect(
      evaluateCiGate({
        planResult: 'success',
        requiredJobs: ['design'],
        jobResults: { design: 'skipped' },
      }).ok,
    ).toBe(false);
  });
});
