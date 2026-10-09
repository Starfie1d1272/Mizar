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
      ['docs/guide/product.md', 'README.md', 'THIRD-PARTY-NOTICES.md'],
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
        runAcceptance: true,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'radar geometry',
      ['packages/radar/src/map-geometry.ts'],
      {
        runQuality: true,
        runAcceptance: true,
        runPlatform: false,
        runQualification: false,
      },
    ],
    [
      'companion runtime',
      ['apps/companion/src/runtime/program-runtime.ts'],
      {
        runQuality: true,
        runAcceptance: true,
        runPlatform: true,
        runQualification: false,
      },
    ],
    [
      'telemetry adapter',
      ['packages/telemetry-gsi/src/adapter.ts'],
      {
        runQuality: true,
        runAcceptance: true,
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
    expect(plan.runOfflineQualification).toBe(files.includes('scripts/qualification/offline.mjs'));
  });

  it.each(['pull_request', 'push'])(
    '%s routes shared producers without extra packaging',
    (eventName) => {
      const packageSources = [
        'packages/core/src/projection/program.ts',
        'packages/radar/src/map-geometry.ts',
        'packages/radar-view/src/render-cache.ts',
        'packages/hud-config/src/index.ts',
        'packages/protocol/src/program.ts',
        'packages/protocol/src/version.ts',
        'packages/protocol/src/index.ts',
        'scripts/local-web-production-browser-smoke.mjs',
      ];
      const companionSources = [
        'runtime/program-runtime.ts',
        'projections/projection-coordinator.ts',
        'program-scenes/director.ts',
        'local-protocol/channel-publisher.ts',
        'hud-config/controller.ts',
        'bp/controller.ts',
        'match-context/controller.ts',
        'series-progress/checkpoint-store.ts',
        'replay/production-replay-composition.ts',
        'output/projector.ts',
        'app.ts',
        'server.ts',
      ].map((path) => `apps/companion/src/${path}`);
      for (const path of [...packageSources, ...companionSources]) {
        expect(createCiPlan({ eventName, changedFiles: [path] }).requiredJobs, path).toEqual(
          path.startsWith('apps/companion/')
            ? ['quality', 'acceptance', 'platform']
            : ['quality', 'acceptance'],
        );
      }
    },
  );

  it.each([
    ['packages/core/test/projection.test.ts', ['quality']],
    ['packages/radar/test/map-geometry.test.ts', ['quality']],
    ['packages/radar-view/test/render-cache.test.ts', ['quality']],
    ['packages/hud-config/test/layout.test.ts', ['quality']],
    ['packages/protocol/test/program.test.ts', ['quality']],
    ['apps/companion/test/program-runtime.test.ts', ['quality', 'platform']],
    ['apps/companion/src/support/logs.ts', ['quality', 'platform']],
    ['packages/testkit/src/replay/clock.ts', ['quality']],
    ['packages/radar-view/src/radar.css', ['quality']],
    ['packages/core/src/README.md', []],
    ['docs/development/development-validation.md', []],
  ])('does not add browser or packaging gates for %s', (path, requiredJobs) => {
    expect(createCiPlan({ changedFiles: [path] }).requiredJobs).toEqual(requiredJobs);
  });

  it.each(['pull_request', 'push'])(
    '%s assigns mirror contracts to quality without rebuilding the product',
    (eventName) => {
      for (const path of [
        'scripts/qualification/box-sync.mjs',
        'scripts/qualification/box-sync.test.mjs',
      ]) {
        expect(createCiPlan({ eventName, changedFiles: [path] }).requiredJobs).toEqual(['quality']);
      }
    },
  );

  it.each([
    ['scripts/qualification/windows-setup.nsi', ['quality', 'qualification_windows']],
    ['scripts/qualification/bundle/update-install.ps1', ['quality', 'qualification_windows']],
    [
      'scripts/qualification/verify-source-ci.mjs',
      ['quality', 'design', 'acceptance', 'platform', 'qualification_windows'],
    ],
    [
      'scripts/qualification/verify-candidate.mjs',
      ['quality', 'design', 'acceptance', 'platform', 'qualification_windows'],
    ],
    [
      'scripts/qualification/verify-promotion.mjs',
      ['quality', 'design', 'acceptance', 'platform', 'qualification_windows'],
    ],
    [
      'scripts/qualification/box-sync-helper.mjs',
      ['quality', 'design', 'acceptance', 'platform', 'qualification_windows'],
    ],
    ['apps/desktop/src-tauri/src/main.rs', ['quality', 'qualification_windows']],
    ['packages/protocol/src/version.ts', ['quality', 'acceptance']],
  ])('mirror changes retain the independent risk owner for %s', (path, requiredJobs) => {
    expect(
      createCiPlan({
        changedFiles: ['scripts/qualification/box-sync.mjs', path],
      }).requiredJobs,
    ).toEqual(requiredJobs);
  });

  it('retains both rename sides and deletion responsibilities for mirror tooling', () => {
    for (const diff of [
      'R100\0scripts/qualification/box-sync.mjs\0scripts/qualification/bundle/update-install.ps1\0',
      'R100\0scripts/qualification/bundle/update-install.ps1\0scripts/qualification/box-sync.mjs\0',
    ]) {
      expect(createCiPlan({ changedFiles: parseGitDiffNameStatus(diff) }).requiredJobs).toEqual([
        'quality',
        'qualification_windows',
      ]);
    }
    expect(
      createCiPlan({
        changedFiles: [{ path: 'scripts/qualification/box-sync.mjs', status: 'D' }],
      }).requiredJobs,
    ).toEqual(['quality']);
  });

  it.each(['pull_request', 'push'])(
    'validates offline self-changes on both platforms for %s',
    (eventName) => {
      const plan = createCiPlan({ eventName, changedFiles: ['scripts/qualification/offline.mjs'] });
      expect(plan.requiredJobs).toEqual(['quality', 'qualification_offline']);
      expect(
        evaluateCiGate({
          planResult: 'success',
          requiredJobs: plan.requiredJobs,
          jobResults: {
            quality: 'skipped',
            qualification_offline: 'success',
            qualification_windows: 'success',
          },
        }).ok,
      ).toBe(false);
    },
  );

  it.each(['pull_request', 'push'])(
    'unions offline tooling with its independent consumers for %s',
    (eventName) => {
      for (const path of [
        'scripts/qualification/offline.mjs',
        'scripts/qualification/offline.test.mjs',
      ]) {
        for (const status of ['M', 'D']) {
          expect(
            createCiPlan({ eventName, changedFiles: [{ path, status }] }).requiredJobs,
          ).toEqual(['quality', 'qualification_offline']);
        }
        expect(
          createCiPlan({
            eventName,
            changedFiles: [path, 'scripts/qualification/windows-setup.nsi'],
          }).requiredJobs,
        ).toEqual(['quality', 'qualification_offline', 'qualification_windows']);
        expect(
          createCiPlan({
            eventName,
            changedFiles: parseGitDiffNameStatus(
              `R100\0${path}\0scripts/qualification/bundle/update-install.ps1\0`,
            ),
          }).requiredJobs,
        ).toEqual(['quality', 'qualification_offline', 'qualification_windows']);
        expect(
          createCiPlan({ eventName, changedFiles: [path, '.github/workflows/ci.yml'] })
            .requiredJobs,
        ).toEqual([
          'quality',
          'design',
          'acceptance',
          'platform',
          'qualification_offline',
          'qualification_windows',
        ]);
      }
    },
  );

  it('unions browser, platform and Windows qualification risks with ordinary docs', () => {
    expect(
      createCiPlan({
        changedFiles: [
          'packages/hud-config/src/index.ts',
          'packages/telemetry-gsi/src/adapter.ts',
          'apps/desktop/src-tauri/src/main.rs',
          'docs/guide/product.md',
        ],
      }).requiredJobs,
    ).toEqual(['quality', 'acceptance', 'platform', 'qualification_windows']);
  });

  it('adding a test cannot shrink producer or harness evidence', () => {
    for (const producer of [
      'packages/telemetry-gsi/src/adapter.ts',
      'tests/acceptance/companion-isolation.ts',
    ]) {
      const original = createCiPlan({ changedFiles: [producer] }).requiredJobs;
      const mixed = createCiPlan({
        changedFiles: [producer, 'packages/core/test/new.test.ts'],
      }).requiredJobs;
      expect(mixed).toEqual(expect.arrayContaining(original));
      expect(mixed).toContain('acceptance');
    }
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
    ['unknown qualification tool', ['scripts/qualification/new-tool.mjs']],
    ['unknown bundled script', ['scripts/qualification/bundle/new-tool.ps1']],
    ['unknown installer asset', ['scripts/qualification/installer-assets/new-asset.bmp']],
    ['unknown evidence script', ['scripts/qualification/evidence/new-verifier.mjs']],
    ['evidence integrity', ['scripts/qualification/evidence/integrity.mjs']],
    ['evidence contract', ['scripts/qualification/evidence/contract.mjs']],
    ['evidence entry', ['scripts/qualification/evidence.mjs']],
    ['Stable trust source', ['apps/companion/src/updates/source.ts']],
    ['update metadata protocol', ['scripts/qualification/update-manifest.mjs']],
    ['runtime trust pin', ['scripts/qualification/runtime-config.mjs']],
    ['type change', [{ path: 'packages/core/src/old.ts', status: 'T' }]],
  ])('%s fails closed to full CI', (_name, changedFiles) => {
    expect(createCiPlan({ eventName: 'pull_request', changedFiles })).toMatchObject(full);
  });

  it('keeps docs-only main pushes selective', () => {
    const plan = createCiPlan({ eventName: 'push', changedFiles: ['README.md'] });
    expect(plan.requiredJobs).toEqual([]);
    expect(plan.runOfflineQualification).toBe(false);
  });

  it.each([
    ['D\tdocs/old.md\n', []],
    ['D\tpackages/radar-view/src/render-cache.ts\n', ['quality', 'acceptance']],
    [
      'R100\tpackages/core/src/projection/program.ts\tdocs/archive/program.md\n',
      ['quality', 'acceptance'],
    ],
    ['R100\tdocs/old.md\tdocs/archive/new.md\n', []],
    ['R096\tdocs/design/old.md\tdocs/archive/old.md\n', ['design']],
    ['R80\tdocs/old.md\tapps/web/src/new.ts\n', ['quality', 'acceptance']],
    [
      'R100\tapps/desktop/src-tauri/src/old.rs\tdocs/archive/old.md\n',
      ['quality', 'qualification_windows'],
    ],
    ['D\tapps/companion/src/output/service.ts\n', ['quality', 'acceptance', 'platform']],
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
    ['bundled GSI settings', 'packages/telemetry-gsi/src/production-config.json'],
    ['artifact contract', 'apps/companion/src/qualification/contract.json'],
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
  ])('main push %s fails closed to full CI', (_name, changedFiles) => {
    const plan = createCiPlan({ eventName: 'push', changedFiles });
    expect(plan).toMatchObject(full);
    expect(plan.requiredJobs).toContain('qualification_offline');
    expect(plan.runOfflineQualification).toBe(true);
  });

  it.each(['apps/web/src/hud.tsx', 'packages/hud-config/src/layout.ts'])(
    'keeps ordinary main %s out of exact Windows packaging',
    (path) => {
      const plan = createCiPlan({ eventName: 'push', changedFiles: [path] });
      expect(plan.runQuality).toBe(true);
      expect(plan.runQualification).toBe(false);
      expect(plan.runOfflineQualification).toBe(false);
    },
  );

  it.each(['schedule', 'workflow_dispatch'])('%s forces full CI', (eventName) => {
    const plan = createCiPlan({ eventName, changedFiles: ['docs/guide/product.md'] });
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
