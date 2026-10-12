import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
