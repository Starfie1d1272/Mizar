import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { checkArchitecture } from './check.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const syntheticRoot = resolve(repositoryRoot, '__mizar_architecture_test_virtual_root__');
const syntheticManifests = Object.fromEntries(
  ['apps', 'packages'].flatMap((root) =>
    readdirSync(resolve(repositoryRoot, root), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(resolve(repositoryRoot, root, entry.name, 'package.json')),
      )
      .map((entry) => {
        const path = `${root}/${entry.name}/package.json`;
        return [path, readFileSync(resolve(repositoryRoot, path), 'utf8')];
      }),
  ),
);

function withFiles(files) {
  return checkArchitecture({ rootDir: syntheticRoot, files: { ...syntheticManifests, ...files } });
}

function expectRule(violations, ruleId, target) {
  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ruleId,
        ...(target ? { target: expect.stringContaining(target) } : {}),
      }),
    ]),
  );
}

function packageManifest(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));
}

describe('architecture checker', () => {
  it('passes the current zero-debt repository', () => {
    expect(checkArchitecture({ rootDir: repositoryRoot })).toEqual([]);
  });

  it('allows a declared dev-only testkit import and the protocol zod dependency', () => {
    const protocolManifest = packageManifest('packages/protocol/package.json');
    protocolManifest.devDependencies = {
      '@mizar/testkit': 'workspace:*',
    };

    expect(
      withFiles({
        'packages/protocol/package.json': JSON.stringify(protocolManifest),
        'packages/protocol/test/testkit-fixture.test.ts':
          "import { fixture } from '@mizar/testkit';\nvoid fixture;\n",
        'packages/protocol/src/zod-fixture.ts': "import { z } from 'zod';\nvoid z;\n",
      }),
    ).toEqual([]);
  });

  it('rejects forbidden runtime manifest dependencies without source imports', () => {
    const cases = [
      {
        manifestPath: 'packages/core/package.json',
        dependencies: { fastify: '5.0.0' },
        ruleId: 'ARCH_CORE_BOUNDARY',
        target: 'fastify',
      },
      {
        manifestPath: 'packages/core/package.json',
        dependencies: { '@mizar/rivalhub': 'workspace:*' },
        ruleId: 'ARCH_CORE_BOUNDARY',
        target: '@mizar/rivalhub',
      },
      {
        manifestPath: 'packages/core/package.json',
        dependencies: { '@mizar/web': 'workspace:*' },
        ruleId: 'ARCH_CORE_BOUNDARY',
        target: '@mizar/web',
      },
      {
        manifestPath: 'packages/core/package.json',
        dependencies: { '@mizar/companion': 'workspace:*' },
        ruleId: 'ARCH_CORE_BOUNDARY',
        target: '@mizar/companion',
      },
      {
        manifestPath: 'packages/protocol/package.json',
        dependencies: { '@mizar/core': 'workspace:*' },
        ruleId: 'ARCH_PROTOCOL_BOUNDARY',
        target: '@mizar/core',
      },
      {
        manifestPath: 'packages/radar/package.json',
        dependencies: { react: '19.0.0' },
        ruleId: 'ARCH_RADAR_BOUNDARY',
        target: 'react',
      },
      {
        manifestPath: 'packages/telemetry-gsi/package.json',
        dependencies: { '@mizar/protocol': 'workspace:*' },
        ruleId: 'ARCH_TELEMETRY_GSI_BOUNDARY',
        target: '@mizar/protocol',
      },
      {
        manifestPath: 'packages/telemetry-gsi/package.json',
        dependencies: { fastify: '5.0.0' },
        ruleId: 'ARCH_TELEMETRY_GSI_BOUNDARY',
        target: 'fastify',
      },
      {
        manifestPath: 'packages/telemetry-cstv/package.json',
        dependencies: { '@mizar/companion': 'workspace:*' },
        ruleId: 'ARCH_TELEMETRY_CSTV_BOUNDARY',
        target: '@mizar/companion',
      },
      {
        manifestPath: 'apps/web/package.json',
        dependencies: { '@mizar/telemetry-gsi': 'workspace:*' },
        ruleId: 'ARCH_WEB_BOUNDARY',
        target: '@mizar/telemetry-gsi',
      },
      {
        manifestPath: 'packages/rivalhub/package.json',
        dependencies: { '@supabase/supabase-js': '2.0.0' },
        ruleId: 'ARCH_RIVALHUB_BOUNDARY',
        target: '@supabase/supabase-js',
      },
    ];

    for (const testCase of cases) {
      const manifest = packageManifest(testCase.manifestPath);
      manifest.dependencies = { ...manifest.dependencies, ...testCase.dependencies };
      expectRule(
        withFiles({ [testCase.manifestPath]: JSON.stringify(manifest) }),
        testCase.ruleId,
        testCase.target,
      );
    }

    const devOnlyManifest = packageManifest('packages/core/package.json');
    devOnlyManifest.devDependencies = {
      fastify: '5.0.0',
      '@mizar/web': 'workspace:*',
    };
    const findings = withFiles({ 'packages/core/package.json': JSON.stringify(devOnlyManifest) });
    expect(findings.every((finding) => finding.ruleId === 'ARCH_WORKSPACE_CYCLE')).toBe(true);
    expectRule(findings, 'ARCH_WORKSPACE_CYCLE');
  }, 15_000);

  it('checks static, export, dynamic, require, and type-only edges', () => {
    const violations = withFiles({
      'packages/core/src/import-edge-fixture.ts': [
        "import 'fastify';",
        "export * from 'react';",
        "import type { ViteConfig } from 'vite';",
        "export async function load() { await import('ws'); return require('node:fs'); }",
        'void (undefined as unknown as ViteConfig);',
      ].join('\n'),
    });

    expect(
      violations.filter((violation) => violation.ruleId === 'ARCH_CORE_BOUNDARY'),
    ).toHaveLength(5);
  });

  it('enforces high-confidence package boundaries', () => {
    expectRule(
      withFiles({ 'packages/core/src/boundary.ts': "import 'fastify';\n" }),
      'ARCH_CORE_BOUNDARY',
      'fastify',
    );
    expectRule(
      withFiles({ 'packages/core/src/boundary.ts': "import 'node:fs';\n" }),
      'ARCH_CORE_BOUNDARY',
      'node:fs',
    );
    expectRule(
      withFiles({
        'packages/protocol/src/boundary.ts': "import type { RuntimeState } from '@mizar/core';\n",
      }),
      'ARCH_PROTOCOL_BOUNDARY',
      '@mizar/core',
    );
    expectRule(
      withFiles({ 'packages/radar/src/boundary.ts': "import React from 'react';\nvoid React;\n" }),
      'ARCH_RADAR_BOUNDARY',
      'react',
    );
    expectRule(
      withFiles({ 'packages/telemetry-gsi/src/boundary.ts': "import 'node:fs';\n" }),
      'ARCH_TELEMETRY_GSI_BOUNDARY',
      'node:fs',
    );
    expectRule(
      withFiles({
        'packages/core/src/cstv-edge.ts':
          "import { create } from '@mizar/telemetry-cstv';\nvoid create;\n",
      }),
      'ARCH_CORE_BOUNDARY',
      '@mizar/telemetry-cstv',
    );
    expectRule(
      withFiles({ 'packages/telemetry-cstv/src/boundary.ts': "import 'node:fs';\n" }),
      'ARCH_TELEMETRY_CSTV_BOUNDARY',
      'node:fs',
    );
    expectRule(
      withFiles({
        'packages/telemetry-cstv/src/boundary.ts':
          "import { adapt } from '@mizar/telemetry-gsi';\nvoid adapt;\n",
      }),
      'ARCH_TELEMETRY_CSTV_BOUNDARY',
      '@mizar/telemetry-gsi',
    );
    expectRule(
      withFiles({
        'packages/telemetry-gsi/src/boundary.ts':
          "import { value } from '@mizar/protocol';\nvoid value;\n",
      }),
      'ARCH_TELEMETRY_GSI_BOUNDARY',
      '@mizar/protocol',
    );
    expectRule(
      withFiles({
        'apps/web/src/boundary.ts': "import { parse } from '@mizar/telemetry-gsi';\nvoid parse;\n",
      }),
      'ARCH_WEB_BOUNDARY',
      '@mizar/telemetry-gsi',
    );
    expectRule(
      withFiles({
        'packages/rivalhub/src/boundary.ts':
          "import { createClient } from '@supabase/supabase-js';\nvoid createClient;\n",
      }),
      'ARCH_RIVALHUB_BOUNDARY',
      '@supabase/supabase-js',
    );
  }, 15_000);

  it('rejects Core imports of Web and Companion even with legal workspace declarations', () => {
    const coreManifest = packageManifest('packages/core/package.json');
    coreManifest.dependencies = {
      '@mizar/web': 'workspace:*',
      '@mizar/companion': 'workspace:*',
    };

    const violations = withFiles({
      'packages/core/package.json': JSON.stringify(coreManifest),
      'packages/core/src/web-edge.ts': "import '@mizar/web';\n",
      'packages/core/src/companion-edge.ts': "import '@mizar/companion';\n",
    });

    expectRule(violations, 'ARCH_CORE_BOUNDARY', '@mizar/web');
    expectRule(violations, 'ARCH_CORE_BOUNDARY', '@mizar/companion');
  });

  it('rejects direct package-source imports and normalizes Windows separators', () => {
    const coreManifest = packageManifest('packages/core/package.json');
    coreManifest.exports['./src'] = './dist/index.js';

    expectRule(
      withFiles({
        'packages/core/package.json': JSON.stringify(coreManifest),
        'apps/web/src/deep-import.ts':
          "import { value } from '@mizar/core/src/index.js';\nvoid value;\n",
      }),
      'ARCH_CROSS_PACKAGE_SOURCE',
      '@mizar/core/src',
    );

    expectRule(
      withFiles({
        'packages\\core\\src\\windows-fixture.ts':
          "require('../../../packages\\\\radar\\\\src\\\\index.js');\n",
      }),
      'ARCH_CROSS_PACKAGE_SOURCE',
      'packages\\radar\\src',
    );
  });

  it('rejects non-src relative cross-workspace paths and unexported package subpaths', () => {
    expectRule(
      withFiles({
        'apps/web/src/relative-dist-import.ts': "import '../../../packages/core/dist/index.js';\n",
      }),
      'ARCH_CROSS_PACKAGE_SOURCE',
      'packages/core/dist',
    );

    expectRule(
      withFiles({
        'apps/web/src/unexported-subpath.ts': "import '@mizar/core/dist/index.js';\n",
      }),
      'ARCH_CROSS_PACKAGE_SOURCE',
      '@mizar/core/dist',
    );
  });

  it('requires declared workspace dependencies and workspace protocol', () => {
    expectRule(
      withFiles({
        'apps/web/src/undeclared.ts':
          "import { value } from '@mizar/telemetry-gsi';\nvoid value;\n",
      }),
      'ARCH_UNDECLARED_WORKSPACE_DEP',
      '@mizar/telemetry-gsi',
    );

    const webManifest = packageManifest('apps/web/package.json');
    webManifest.dependencies = {
      '@mizar/telemetry-gsi': '^1.0.0',
      ...webManifest.dependencies,
    };
    expectRule(
      withFiles({ 'apps/web/package.json': JSON.stringify(webManifest) }),
      'ARCH_WORKSPACE_PROTOCOL',
      '@mizar/telemetry-gsi',
    );
  });

  it('rejects runtime testkit dependencies, cycles, and TypeScript paths', () => {
    const coreManifest = packageManifest('packages/core/package.json');
    coreManifest.dependencies = {
      '@mizar/testkit': 'workspace:*',
    };
    expectRule(
      withFiles({ 'packages/core/package.json': JSON.stringify(coreManifest) }),
      'ARCH_TESTKIT_RUNTIME',
      '@mizar/testkit',
    );

    const cycleA = {
      name: '@mizar/cycle-a',
      private: true,
      type: 'module',
      files: ['dist'],
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      dependencies: { '@mizar/cycle-b': 'workspace:*' },
    };
    const cycleB = {
      name: '@mizar/cycle-b',
      private: true,
      type: 'module',
      files: ['dist'],
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      dependencies: { '@mizar/cycle-a': 'workspace:*' },
    };
    expectRule(
      withFiles({
        'packages/cycle-a/package.json': JSON.stringify(cycleA),
        'packages/cycle-b/package.json': JSON.stringify(cycleB),
        'tsconfig.architecture-fixture.json': JSON.stringify({
          compilerOptions: { paths: { '@fixture/*': ['fixtures/*'] } },
        }),
      }),
      'ARCH_WORKSPACE_CYCLE',
      'cycle-a',
    );
    expectRule(
      withFiles({
        'tsconfig.architecture-fixture.json': JSON.stringify({
          compilerOptions: { paths: { '@fixture/*': ['fixtures/*'] } },
        }),
      }),
      'ARCH_TS_PATH_ALIAS',
      'compilerOptions.paths',
    );
  });

  it('keeps the direct cs2parser dependency and imports inside telemetry-cstv', () => {
    const companionManifest = packageManifest('apps/companion/package.json');
    companionManifest.dependencies = {
      ...companionManifest.dependencies,
      cs2parser: '2.5.0',
    };

    expectRule(
      withFiles({ 'apps/companion/package.json': JSON.stringify(companionManifest) }),
      'ARCH_CSTV_PARSER_OWNERSHIP',
      'cs2parser',
    );
    expectRule(
      withFiles({ 'apps/companion/src/parser-edge.ts': "import 'cs2parser';\n" }),
      'ARCH_CSTV_PARSER_OWNERSHIP',
      'cs2parser',
    );
    expectRule(
      withFiles({
        'apps/web/src/parser-edge.ts': "import type { DemoReader } from 'cs2parser';\n",
      }),
      'ARCH_CSTV_PARSER_OWNERSHIP',
      'cs2parser',
    );
    expectRule(
      withFiles({
        'packages/core/src/parser-edge.ts': "import { DemoReader } from 'cs2parser';\n",
      }),
      'ARCH_CSTV_PARSER_OWNERSHIP',
      'cs2parser',
    );
    expectRule(
      withFiles({
        'packages/testkit/src/parser-edge.ts': "await import('cs2parser/dist/index.mjs');\n",
      }),
      'ARCH_CSTV_PARSER_OWNERSHIP',
      'cs2parser/dist',
    );

    expect(
      withFiles({
        'packages/telemetry-cstv/src/parser-edge.ts': "import { DemoReader } from 'cs2parser';\n",
      }),
    ).toEqual([]);
  }, 15_000);

  it('rejects shared package source exports', () => {
    const coreManifest = packageManifest('packages/core/package.json');
    coreManifest.files = ['src'];
    coreManifest.exports = {
      '.': {
        types: './src/index.ts',
        import: './src/index.ts',
      },
    };

    expectRule(
      withFiles({ 'packages/core/package.json': JSON.stringify(coreManifest) }),
      'ARCH_PACKAGE_EXPORTS',
      'exports',
    );
  });

  it('keeps Program projection imports on the Program-safe graph', () => {
    expectRule(
      withFiles({
        'packages/core/src/projection/program-boundary.ts':
          "import { cue } from './observer-assist.js';\nvoid cue;\n",
        'packages/core/src/projection/observer-assist.ts': 'export const cue = 1;\n',
      }),
      'ARCH_PROGRAM_PROJECTION_BOUNDARY',
      'observer-assist',
    );

    expectRule(
      withFiles({
        'packages/core/src/projection/program-indirect.ts':
          "import { value } from './program-safe-helper.js';\nvoid value;\n",
        'packages/core/src/projection/program-safe-helper.ts':
          "import { cue } from './lookahead.js';\nvoid cue;\n",
        'packages/core/src/projection/lookahead.ts': 'export const cue = 1;\n',
      }),
      'ARCH_PROGRAM_PROJECTION_BOUNDARY',
      'lookahead',
    );

    expectRule(
      withFiles({
        'packages/core/src/projection/program-helper-boundary.ts':
          "import { value } from '../presentation-helper.js';\nvoid value;\n",
        'packages/core/src/presentation-helper.ts':
          "import { event } from './game-events/index.js';\nexport const value = event;\n",
        'packages/core/src/game-events/index.ts': 'export const event = 1;\n',
      }),
      'ARCH_PROGRAM_PROJECTION_BOUNDARY',
      'game-events',
    );
  }, 15_000);
});

describe('architecture ESLint fast feedback', () => {
  it('uses the shared policy for direct forbidden imports', async () => {
    const eslint = new ESLint({ cwd: repositoryRoot });
    const [result] = await eslint.lintText(
      "import { FastifyInstance } from 'fastify';\nvoid FastifyInstance;\n",
      {
        filePath: 'packages/core/src/index.ts',
      },
    );

    expect(result?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'no-restricted-imports',
          message: expect.stringContaining('framework'),
        }),
      ]),
    );

    const [deepImportResult] = await eslint.lintText(
      "import { value } from '../../radar/src/index.js';\nvoid value;\n",
      { filePath: 'packages/core/src/index.ts' },
    );
    expect(deepImportResult?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'no-restricted-imports',
          message: expect.stringContaining('src directory'),
        }),
      ]),
    );

    const [parserResult] = await eslint.lintText("import { DemoReader } from 'cs2parser';\n", {
      filePath: 'apps/web/src/main.tsx',
    });
    expect(parserResult?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'no-restricted-imports',
          message: expect.stringContaining('owned exclusively by packages/telemetry-cstv'),
        }),
      ]),
    );
  }, 15_000);
});
