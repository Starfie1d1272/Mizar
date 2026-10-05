import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from './check.mjs';
import { workspacePackageName, workspacePathForPackage } from './policy.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifest = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const baseManifests = Object.fromEntries(
  ['apps', 'packages'].flatMap((group) =>
    readdirSync(resolve(root, group))
      .map((name) => `${group}/${name}/package.json`)
      .filter((path) => existsSync(resolve(root, path)))
      .map((path) => [path, readFileSync(resolve(root, path), 'utf8')]),
  ),
);
const check = (files) =>
  checkArchitecture({
    rootDir: resolve(root, '__build_graph_virtual_root__'),
    files: { ...baseManifests, ...files },
  });

describe('workspace build graph', () => {
  it('discovers scopes and paths from manifests', () => {
    expect(workspacePackageName('@mizar-hud/radar-view/react')).toBe('@mizar-hud/radar-view');
    expect(workspacePathForPackage('@mizar-hud/radar-view')).toBe('packages/radar-view');
    expect(workspacePackageName('@other/name')).toBeUndefined();
  });

  it('rejects an undeclared import from the HUD scope', () => {
    expect(check({ 'packages/replay/src/invalid.ts': "import '@mizar-hud/radar-view';" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'ARCH_UNDECLARED_WORKSPACE_DEP' }),
      ]),
    );
  });

  it.each([
    {
      'package.json': JSON.stringify({
        scripts: {
          bad: 'pnpm --filter @mizar/protocol... --fail-if-no-match run build && pnpm --filter @mizar/core... --fail-if-no-match run build',
        },
      }),
    },
    {
      '.github/workflows/bad.yml':
        'run: |\n  pnpm --filter @mizar/protocol... --fail-if-no-match run build\n  pnpm --filter @mizar/core... --fail-if-no-match run build',
    },

    { 'packages/rivalhub/tsconfig.json': '{"references":[{"path":"../core"}]}' },
    {
      'package.json': JSON.stringify({
        scripts: { bad: 'pnpm --filter @mizar/protocol build && pnpm --filter @mizar/core build' },
      }),
    },
    { '.github/workflows/bad.yml': 'run: pnpm --filter @mizar/rivalhub build' },
    {
      'packages/core/package.json': JSON.stringify({
        ...manifest('packages/core/package.json'),
        scripts: { build: 'tsc -b --force', typecheck: 'tsc -p tsconfig.json' },
      }),
    },
  ])('rejects drift and unsafe entry: %j', (files) => {
    expect(check(files)).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_BUILD_GRAPH' })]),
    );
  });

  it('rejects missing workspace manifests and a weakened task declaration', () => {
    const owner = manifest('packages/replay/package.json');
    owner.devDependencies['@another/missing'] = 'workspace:*';
    expect(check({ 'packages/replay/package.json': JSON.stringify(owner) })).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_WORKSPACE_MISSING' })]),
    );
    const config = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8').replace(
      "dependsOn: ['^build']",
      'dependsOn: []',
    );
    expect(check({ 'pnpm-workspace.yaml': config })).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_BUILD_GRAPH' })]),
    );
  });

  it('rejects cycles introduced by dev-only build dependencies', () => {
    const core = manifest('packages/core/package.json');
    core.devDependencies['@mizar/testkit'] = 'workspace:*';
    expect(check({ 'packages/core/package.json': JSON.stringify(core) })).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_WORKSPACE_CYCLE' })]),
    );
  });

  it('matches the actual stable pnpm build task graph to every manifest edge', () => {
    const output = execFileSync(
      process.platform === 'win32' ? 'pnpm.exe' : 'pnpm',
      ['-r', 'run', '--dry-run', '--json', 'build'],
      { cwd: root, encoding: 'utf8' },
    );
    const { tasks } = JSON.parse(output.slice(output.indexOf('{')));
    const owners = new Map(
      tasks.map((task) => [manifest(`${task.project}/package.json`).name, task.project]),
    );
    for (const task of tasks) {
      const owner = manifest(`${task.project}/package.json`);
      const expected = new Set(
        ['dependencies', 'devDependencies', 'optionalDependencies']
          .flatMap((field) => Object.keys(owner[field] ?? {}))
          .filter((name) => owners.has(name))
          .map((name) => owners.get(name)),
      );
      expect(task.missingScript).toBe(false);
      expect(new Set(task.dependsOn.map((edge) => edge.project))).toEqual(expected);
      expect(task.dependsOn.every((edge) => edge.script === 'build')).toBe(true);
    }
  });

  it('fails unmatched dependency filters', () => {
    expect(() =>
      execFileSync(
        process.platform === 'win32' ? 'pnpm.exe' : 'pnpm',
        ['--filter', '@missing/closure...', '--fail-if-no-match', 'run', 'build'],
        { cwd: root, stdio: 'pipe' },
      ),
    ).toThrow();
  });
});
