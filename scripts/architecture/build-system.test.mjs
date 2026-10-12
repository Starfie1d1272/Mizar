import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const manifest = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

describe('workspace build graph', () => {
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
});
