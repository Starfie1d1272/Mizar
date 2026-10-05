import { posix } from 'node:path';

// pnpm owns cross-package ordering. TypeScript compiles/checks only its owner.
export function checkBuildSystem(repository, workspaces, report) {
  const fail = (file, message) => report({ ruleId: 'ARCH_BUILD_GRAPH', file, message });
  for (const [file, source] of repository.files) {
    if (/tsconfig[^/]*\.json$/.test(file)) {
      const config = JSON.parse(source);
      if (config.references?.length) {
        fail(
          file,
          'Cross-project references create a second build graph; use manifest dependencies and pnpm tasks.',
        );
      }
    }
    if (!file.endsWith('package.json') && !file.startsWith('.github/workflows/')) continue;
    const commands = file.endsWith('package.json')
      ? Object.values(JSON.parse(source).scripts ?? {})
      : [source];
    for (const command of commands) {
      for (const entry of command.split(/&&|\n/)) {
        if (
          /pnpm\s+--filter\s+\S+\s+(?:run\s+)?build\b/.test(entry) &&
          !entry.includes('--fail-if-no-match')
        ) {
          fail(
            file,
            'Filtered build must explicitly reject unmatched workspaces with --fail-if-no-match.',
          );
        }
      }
      if (/--filter\s+\S+\s+(?:run\s+)?build\s*&&\s*pnpm\s+--filter/.test(command)) {
        fail(
          file,
          'Do not enumerate workspace build order; use one dependency selector or build:packages.',
        );
      }
      for (const match of command.matchAll(
        /pnpm\s+--filter\s+([^\s]+)\s+(?:--fail-if-no-match\s+)?(?:run\s+)?build\b/g,
      )) {
        const target = workspaces.get(match[1]);
        if (
          target &&
          ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) =>
            Object.keys(target.manifest[field] ?? {}).some((name) => workspaces.has(name)),
          )
        ) {
          fail(file, `Filtered build of ${target.name} must include dependencies using ... .`);
        }
      }
    }
  }
  for (const info of workspaces.values()) {
    const scripts = info.manifest.scripts ?? {};
    if (/tsc\s+-b|--force/.test(scripts.build ?? '')) {
      fail(
        info.manifestPath,
        'Package build must compile its own project without --force or tsc -b.',
      );
    }
    for (const command of (scripts.typecheck ?? '').split('&&')) {
      if (/\btsc\b/.test(command) && !/--noEmit\b/.test(command)) {
        fail(
          info.manifestPath,
          'Every typecheck compiler invocation must explicitly use --noEmit.',
        );
      }
    }
    const configPath = posix.join(info.dir, 'tsconfig.json');
    if (repository.has(configPath) && !scripts.typecheck)
      fail(info.manifestPath, 'TS workspace must declare typecheck.');
  }
  const config = repository.read('pnpm-workspace.yaml');
  if (
    config !== undefined &&
    (!/disallowWorkspaceCycles:\s*true/.test(config) ||
      !/tasks:[\s\S]*build:[\s\S]*dependsOn:.*\^build/.test(config))
  ) {
    fail('pnpm-workspace.yaml', 'Enable dependency build tasks, cycle rejection.');
  }
}
