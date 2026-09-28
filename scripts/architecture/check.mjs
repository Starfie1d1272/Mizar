import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { checkDesign } from './design.mjs';

import {
  ARCHITECTURE_SOURCE_EXTENSIONS,
  CSTV_PARSER_OWNER,
  CSTV_PARSER_PACKAGE,
  CSTV_PARSER_OWNERSHIP_MESSAGE,
  PACKAGE_BOUNDARIES,
  RUNTIME_DEPENDENCY_FIELDS,
  WORKSPACE_DEPENDENCY_FIELDS,
  WORKSPACE_PACKAGE_PREFIX,
  isNodeBuiltin,
  matchesPolicyTarget,
  workspacePackageName,
} from './policy.mjs';

const BOUNDARY_RULE_IDS = Object.freeze({
  core: 'ARCH_CORE_BOUNDARY',
  protocol: 'ARCH_PROTOCOL_BOUNDARY',
  radar: 'ARCH_RADAR_BOUNDARY',
  'telemetry-gsi': 'ARCH_TELEMETRY_GSI_BOUNDARY',
  'telemetry-cstv': 'ARCH_TELEMETRY_CSTV_BOUNDARY',
  web: 'ARCH_WEB_BOUNDARY',
  rivalhub: 'ARCH_RIVALHUB_BOUNDARY',
});

const CONTRACT_WORKSPACE_ROOTS = ['apps', 'packages'];
const SOURCE_ROOT_NAMES = new Set(['src', 'test', 'tests']);
const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.pnpm-store',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export function checkArchitecture(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const repository = createRepository(rootDir, options.files);
  const violations = [];
  const seenViolations = new Set();
  const report = (violation) => {
    const key = `${violation.ruleId}|${violation.file}|${violation.target ?? ''}|${violation.message}`;
    if (seenViolations.has(key)) return;
    seenViolations.add(key);
    violations.push(violation);
  };

  const workspaces = discoverWorkspaces(repository, report);
  checkPackageExports(workspaces, report);
  checkTsPathAliases(repository, report);
  checkWorkspaceDependencyDeclarations(workspaces, report);
  checkManifestBoundaryDependencies(workspaces, report);
  checkCstvParserManifestOwnership(workspaces, report);

  const records = loadSourceRecords(repository, workspaces);
  checkImportEdges(records, repository, workspaces, report);
  checkCstvParserImportOwnership(records, report);
  checkProgramProjectionImportOwnership(records, repository, report);
  checkWorkspaceCycles(workspaces, report);
  checkDesign(repository, records, report);

  return violations.sort((left, right) => {
    const leftKey = `${left.file}|${left.ruleId}|${left.target ?? ''}`;
    const rightKey = `${right.file}|${right.ruleId}|${right.target ?? ''}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function formatArchitectureViolation(violation) {
  const target = violation.target ? ` -> ${violation.target}` : '';
  return `${violation.ruleId} ${violation.file}${target}: ${violation.message}`;
}

function createRepository(rootDir, overlay = undefined) {
  const files = new Map();

  if (existsSync(rootDir)) collectContractFiles(rootDir, files);

  for (const [path, source] of Object.entries(overlay ?? {})) {
    files.set(normalizeRelativePath(path), source);
  }

  return {
    rootDir,
    files,
    has(path) {
      return files.has(normalizeRelativePath(path));
    },
    read(path) {
      return files.get(normalizeRelativePath(path));
    },
  };
}

function collectContractFiles(rootDir, files) {
  for (const workspaceRoot of CONTRACT_WORKSPACE_ROOTS) {
    const absoluteRoot = join(rootDir, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;

    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      collectWorkspaceFiles(rootDir, join(absoluteRoot, entry.name), files);
    }
  }

  collectAppStyles(rootDir, join(rootDir, 'apps'), files);
  const generatedTokens = join(rootDir, 'packages/design-tokens/generated/tokens.css');
  if (existsSync(generatedTokens))
    files.set('packages/design-tokens/generated/tokens.css', readFileSync(generatedTokens, 'utf8'));
  collectTsConfigFiles(rootDir, rootDir, files);
}

function collectAppStyles(rootDir, directory, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name) || entry.name === '.agent-tmp') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectAppStyles(rootDir, path, files);
    else if (entry.isFile() && entry.name.endsWith('.css'))
      files.set(normalizeRelativePath(relative(rootDir, path)), readFileSync(path, 'utf8'));
  }
}

function collectWorkspaceFiles(rootDir, workspaceDirectory, files) {
  const manifestPath = join(workspaceDirectory, 'package.json');
  if (existsSync(manifestPath)) {
    files.set(
      normalizeRelativePath(relative(rootDir, manifestPath)),
      readFileSync(manifestPath, 'utf8'),
    );
  }

  for (const sourceRootName of SOURCE_ROOT_NAMES) {
    const sourceRoot = join(workspaceDirectory, sourceRootName);
    if (existsSync(sourceRoot)) collectSourceFiles(rootDir, sourceRoot, files);
  }
}

function collectSourceFiles(rootDir, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(rootDir, absolutePath, files);
      continue;
    }

    if (!entry.isFile()) continue;
    const relativePath = normalizeRelativePath(relative(rootDir, absolutePath));
    if (
      (isSourcePath(relativePath) || /\.(?:css|json)$/.test(relativePath)) &&
      !relativePath.endsWith('.d.ts')
    ) {
      files.set(relativePath, readFileSync(absolutePath, 'utf8'));
    }
  }
}

function collectTsConfigFiles(rootDir, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTsConfigFiles(rootDir, absolutePath, files);
      continue;
    }

    if (!entry.isFile() || !/^tsconfig(?:\.[^/]+)?\.json$/.test(entry.name)) continue;
    files.set(
      normalizeRelativePath(relative(rootDir, absolutePath)),
      readFileSync(absolutePath, 'utf8'),
    );
  }
}

function discoverWorkspaces(repository, report) {
  const workspaces = new Map();

  for (const path of [...repository.files.keys()].sort()) {
    if (!/^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)) continue;

    const source = repository.read(path);
    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch (error) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: path,
        target: path,
        message: `Workspace package manifest must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: path,
        target: 'name',
        message: 'Every workspace package manifest must declare a non-empty package name.',
      });
      continue;
    }

    const info = {
      name: manifest.name,
      dir: dirname(path),
      manifestPath: path,
      manifest,
    };

    if (workspaces.has(info.name)) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: path,
        target: info.name,
        message: `Workspace package name is duplicated; keep one canonical manifest for ${info.name}.`,
      });
      continue;
    }

    workspaces.set(info.name, info);
  }

  return workspaces;
}

function checkPackageExports(workspaces, report) {
  for (const info of [...workspaces.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!info.dir.startsWith('packages/')) continue;

    const manifest = info.manifest;
    const isTokens = info.name === '@mizar/design-tokens';
    const files = manifest.files;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.some((entry) => typeof entry !== 'string' || !isDistArtifactPath(entry))
    ) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: info.manifestPath,
        target: 'files',
        message:
          'Shared packages may publish only build artifacts under dist; do not expose source files or unrelated paths.',
      });
    }

    if (manifest.type !== 'module') {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: info.manifestPath,
        target: 'type',
        message: 'Shared packages must use ESM with package.json type=module.',
      });
    }

    const exportTargets = collectStringValues(manifest.exports);
    if (exportTargets.length === 0 || exportTargets.some((target) => !isDistArtifactPath(target))) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: info.manifestPath,
        target: 'exports',
        message:
          'Shared package exports must point to dist artifacts, never src/*.ts or src/*.tsx.',
      });
    }

    const rootExportTargets = collectStringValues(
      typeof manifest.exports === 'object' &&
        manifest.exports !== null &&
        !Array.isArray(manifest.exports)
        ? manifest.exports['.']
        : manifest.exports,
    );
    if (
      isTokens &&
      (rootExportTargets.length !== 1 ||
        rootExportTargets[0] !== './dist/tokens.css' ||
        exportTargets.some((target) => target !== './dist/tokens.css') ||
        RUNTIME_DEPENDENCY_FIELDS.some((field) => Object.keys(manifest[field] ?? {}).length > 0))
    ) {
      report({
        ruleId: 'ARCH_DESIGN_PACKAGE',
        file: info.manifestPath,
        message: 'Design tokens is a dependency-free static CSS package.',
      });
    }
    if (!isTokens && !rootExportTargets.some((target) => target.endsWith('.js'))) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: info.manifestPath,
        target: 'exports["."].import',
        message: 'Shared package root exports must expose an ESM JavaScript dist artifact.',
      });
    }
    if (!isTokens && !rootExportTargets.some((target) => target.endsWith('.d.ts'))) {
      report({
        ruleId: 'ARCH_PACKAGE_EXPORTS',
        file: info.manifestPath,
        target: 'exports["."].types',
        message: 'Shared package root exports must expose a declaration-file dist artifact.',
      });
    }
  }
}

function collectStringValues(value, values = []) {
  if (typeof value === 'string') {
    values.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStringValues(entry, values);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStringValues(entry, values);
  }
  return values;
}

function isDistArtifactPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized === 'dist' ||
    normalized.startsWith('dist/') ||
    normalized === './dist' ||
    normalized.startsWith('./dist/')
  );
}

function checkTsPathAliases(repository, report) {
  for (const path of [...repository.files.keys()].sort()) {
    if (!/^tsconfig(?:\.[^/]+)?\.json$/.test(basename(path))) continue;

    let parsed;
    try {
      parsed = ts.parseConfigFileTextToJson(path, repository.read(path));
    } catch {
      continue;
    }

    if (
      parsed.error ||
      !parsed.config?.compilerOptions ||
      !Object.hasOwn(parsed.config.compilerOptions, 'paths')
    ) {
      continue;
    }

    report({
      ruleId: 'ARCH_TS_PATH_ALIAS',
      file: path,
      target: 'compilerOptions.paths',
      message:
        'Do not use TypeScript paths aliases to bypass workspace package names and package exports; add or revise an architecture decision first.',
    });
  }
}

function checkWorkspaceDependencyDeclarations(workspaces, report) {
  for (const info of workspaces.values()) {
    for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
      const dependencies = info.manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;

      for (const [dependency, version] of Object.entries(dependencies)) {
        if (!workspacePackageName(dependency)) continue;
        if (typeof version !== 'string' || !version.startsWith('workspace:')) {
          report({
            ruleId: 'ARCH_WORKSPACE_PROTOCOL',
            file: info.manifestPath,
            target: `${dependency} (${String(version)})`,
            message:
              'Internal workspace dependencies must use pnpm workspace: protocol; do not use semver or file paths.',
          });
        }
      }
    }

    if (info.name === '@mizar/testkit') continue;
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      const dependencies = info.manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      if (!Object.hasOwn(dependencies, '@mizar/testkit')) continue;

      report({
        ruleId: 'ARCH_TESTKIT_RUNTIME',
        file: info.manifestPath,
        target: '@mizar/testkit',
        message:
          'testkit owns capture consumption, replay, simulation, and fault injection; production capture recorder belongs to the Companion telemetry runtime and testkit may be used only as a dev-only dependency.',
      });
    }
  }
}

function checkManifestBoundaryDependencies(workspaces, report) {
  for (const info of workspaces.values()) {
    const policy = PACKAGE_BOUNDARIES[info.name];
    const ruleId = boundaryRuleIdFor(info.name);
    if (!policy || !ruleId) continue;

    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      const dependencies = info.manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;

      for (const dependency of Object.keys(dependencies)) {
        const targetName = workspacePackageName(dependency) ?? dependency;
        if (!matchesBoundaryPolicy(policy, dependency, targetName)) continue;

        report({
          ruleId,
          file: info.manifestPath,
          target: dependency,
          message: `${policy.message} Remove ${dependency} from ${field}; devDependencies remain available for test/tooling-only use.`,
        });
      }
    }
  }
}

function checkCstvParserManifestOwnership(workspaces, report) {
  for (const info of workspaces.values()) {
    if (info.name === CSTV_PARSER_OWNER) continue;

    for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
      const dependencies = info.manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      if (!Object.hasOwn(dependencies, CSTV_PARSER_PACKAGE)) continue;

      report({
        ruleId: 'ARCH_CSTV_PARSER_OWNERSHIP',
        file: info.manifestPath,
        target: CSTV_PARSER_PACKAGE,
        message: `${CSTV_PARSER_OWNERSHIP_MESSAGE} Remove it from ${field}.`,
      });
    }
  }
}

function loadSourceRecords(repository, workspaces) {
  const records = new Map();

  for (const path of [...repository.files.keys()].sort()) {
    if (!isSourcePath(path) || path.endsWith('.d.ts')) continue;

    const owner = workspaceForPath(path, workspaces);
    if (!owner || !isRelevantWorkspaceSource(path, owner)) continue;

    const ast = ts.createSourceFile(
      path,
      repository.read(path),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(path),
    );
    const allEdges = moduleEdges(ast);
    records.set(path, {
      path,
      source: repository.read(path),
      ast,
      owner,
      kind: sourceKind(path, owner),
      allEdges,
    });
  }

  return records;
}

function isSourcePath(path) {
  return ARCHITECTURE_SOURCE_EXTENSIONS.has(extname(path));
}

function isRelevantWorkspaceSource(path, owner) {
  const packageRelativePath = path.slice(`${owner.dir}/`.length);
  return (
    packageRelativePath.startsWith('src/') ||
    packageRelativePath.startsWith('test/') ||
    packageRelativePath.startsWith('tests/') ||
    /\.(?:test|spec)\.[^.]+$/.test(packageRelativePath)
  );
}

function sourceKind(path, owner) {
  const packageRelativePath = path.slice(`${owner.dir}/`.length);
  return packageRelativePath.startsWith('test/') ||
    packageRelativePath.startsWith('tests/') ||
    /\.(?:test|spec)\.[^.]+$/.test(packageRelativePath)
    ? 'test'
    : 'production';
}

function scriptKind(path) {
  return path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function moduleEdges(ast) {
  const edges = [];
  const add = (specifier, runtime, kind) => {
    edges.push({ specifier, runtime, kind });
  };

  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      add(statement.moduleSpecifier.text, isRuntimeImport(statement), 'import');
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      add(statement.moduleSpecifier.text, isRuntimeExport(statement), 'export');
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const expression = statement.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) add(expression.text, true, 'import-equals');
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        if (expression.kind === ts.SyntaxKind.ImportKeyword)
          add(argument.text, true, 'dynamic-import');
        if (ts.isIdentifier(expression) && expression.text === 'require')
          add(argument.text, true, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(ast, visit);

  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.specifier}|${edge.runtime}|${edge.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRuntimeImport(statement) {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)))
    return true;
  return clause.namedBindings
    ? clause.namedBindings.elements.some((element) => !element.isTypeOnly)
    : true;
}

function isRuntimeExport(statement) {
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return true;
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

function checkImportEdges(records, repository, workspaces, report) {
  for (const record of records.values()) {
    for (const edge of record.allEdges) {
      const workspaceSpecifier = workspacePackageName(edge.specifier);
      const workspaceTarget = workspaceSpecifier ? workspaces.get(workspaceSpecifier) : undefined;
      const resolvedPath = resolveRelativeModule(record.path, edge.specifier, repository);
      const relativeWorkspaceTarget = relativeWorkspacePackage(
        record.path,
        edge.specifier,
        workspaces,
      );
      const resolvedWorkspaceTarget = resolvedPath
        ? workspaceForPath(resolvedPath, workspaces)
        : undefined;
      const target = workspaceTarget ?? relativeWorkspaceTarget ?? resolvedWorkspaceTarget;

      checkCrossPackageSourceImport(record, edge, target, workspaces, report);
      checkPackageBoundary(record, edge, resolvedPath, target, report);

      if (!target || !record.owner || target.name === record.owner.name) continue;

      if (!declaresDependency(record.owner, target.name)) {
        report({
          ruleId: 'ARCH_UNDECLARED_WORKSPACE_DEP',
          file: record.path,
          target: target.name,
          message: `Declare ${target.name} explicitly in ${record.owner.manifestPath}; root hoisting must not provide workspace dependencies accidentally.`,
        });
      }

      if (record.kind === 'production' && target.name === '@mizar/testkit' && edge.runtime) {
        report({
          ruleId: 'ARCH_TESTKIT_RUNTIME',
          file: record.path,
          target: target.name,
          message:
            'Production runtime code may not import testkit; keep capture consumption, replay, simulation, and fault-injection infrastructure in dev-only tests and tooling. Production capture recorder belongs to the Companion telemetry runtime.',
        });
      }
    }
  }
}

function checkCstvParserImportOwnership(records, report) {
  for (const record of records.values()) {
    if (record.owner.name === CSTV_PARSER_OWNER) continue;

    for (const edge of record.allEdges) {
      if (!isCstvParserSpecifier(edge.specifier)) continue;

      report({
        ruleId: 'ARCH_CSTV_PARSER_OWNERSHIP',
        file: record.path,
        target: edge.specifier,
        message: CSTV_PARSER_OWNERSHIP_MESSAGE,
      });
    }
  }
}

function checkProgramProjectionImportOwnership(records, repository, report) {
  const entryRecords = [...records.values()].filter(
    (record) => record.owner.name === '@mizar/core' && isProgramProjectionPath(record.path),
  );
  const visited = new Set();
  const queue = entryRecords.map((record) => ({ record, entryPath: record.path }));

  while (queue.length > 0) {
    const { record, entryPath } = queue.shift();
    const visitKey = `${entryPath}|${record.path}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    if (isForbiddenProgramProjectionPath(record.path)) {
      report({
        ruleId: 'ARCH_PROGRAM_PROJECTION_BOUNDARY',
        file: entryPath,
        target: record.path,
        message:
          'Program projection imports must stay on the Program-safe graph; observer assist, future/lookahead, and gameplay event modules are forbidden.',
      });
      continue;
    }

    for (const edge of record.allEdges) {
      const resolvedPath = resolveRelativeModule(record.path, edge.specifier, repository);
      const target = resolvedPath ? records.get(resolvedPath) : undefined;
      if (isForbiddenProgramProjectionSpecifier(edge.specifier, resolvedPath)) {
        report({
          ruleId: 'ARCH_PROGRAM_PROJECTION_BOUNDARY',
          file: entryPath,
          target: edge.specifier,
          message:
            'Program projection imports must stay on the Program-safe graph; observer assist, future/lookahead, and gameplay event modules are forbidden.',
        });
        continue;
      }
      if (target && target.path.startsWith('packages/core/src/')) {
        queue.push({ record: target, entryPath });
      }
    }
  }
}

function isProgramProjectionPath(path) {
  return /^packages\/core\/src\/projection\/program(?:[-/].*)?\.[cm]?[jt]sx?$/.test(path);
}

function isForbiddenProgramProjectionPath(path) {
  return /(?:^|\/)(?:observer-assist|lookahead|future|game-events)(?:\/|\.|$)/.test(path);
}

function isForbiddenProgramProjectionSpecifier(specifier, resolvedPath) {
  return (
    isForbiddenProgramProjectionPath(specifier.replaceAll('\\', '/')) ||
    (resolvedPath ? isForbiddenProgramProjectionPath(resolvedPath) : false)
  );
}

function isCstvParserSpecifier(specifier) {
  const normalized = specifier.replaceAll('\\', '/');
  return normalized === CSTV_PARSER_PACKAGE || normalized.startsWith(`${CSTV_PARSER_PACKAGE}/`);
}

function checkCrossPackageSourceImport(record, edge, target, workspaces, report) {
  const packageSpecifier = workspacePackageName(edge.specifier);
  const packageTarget = packageSpecifier ? workspaces.get(packageSpecifier) : undefined;
  const normalizedSpecifier = edge.specifier.replaceAll('\\', '/');
  const packageSubpath = packageTarget
    ? normalizedSpecifier.slice(packageSpecifier.length)
    : undefined;
  const invalidPackageSubpath =
    packageTarget &&
    packageSubpath &&
    !isPublicWorkspaceSubpath(packageTarget, `.${packageSubpath}`);
  const relativeTarget = relativeWorkspacePackage(record.path, edge.specifier, workspaces);
  const relativeCrossWorkspace = relativeTarget && relativeTarget.name !== record.owner.name;

  if (
    ((invalidPackageSubpath && packageTarget) || relativeCrossWorkspace) &&
    target &&
    target.name !== record.owner.name
  ) {
    report({
      ruleId: 'ARCH_CROSS_PACKAGE_SOURCE',
      file: record.path,
      target: edge.specifier,
      message:
        'Cross-workspace imports must use the target package name and an actually exported public subpath; relative paths and unexported internal paths are forbidden.',
    });
  }
}

function checkPackageBoundary(record, edge, resolvedPath, target, report) {
  if (record.kind !== 'production') return;

  const policy = PACKAGE_BOUNDARIES[record.owner.name];
  if (!policy) return;

  const ruleId = boundaryRuleIdFor(record.owner.name);
  if (!ruleId) return;

  const normalizedSpecifier = edge.specifier.replaceAll('\\', '/');
  const targetPath = resolvedPath?.replaceAll('\\', '/');
  const forbiddenWorkspacePath = policy.forbiddenWorkspacePaths.some(
    (path) =>
      normalizedSpecifier.includes(path.replaceAll('\\', '/')) || targetPath?.startsWith(path),
  );

  if (matchesBoundaryPolicy(policy, edge.specifier, target?.name) || forbiddenWorkspacePath) {
    report({
      ruleId,
      file: record.path,
      target: edge.specifier,
      message: policy.message,
    });
  }
}

function boundaryRuleIdFor(packageName) {
  return BOUNDARY_RULE_IDS[packageName.slice(`${WORKSPACE_PACKAGE_PREFIX.length}`)];
}

function matchesBoundaryPolicy(policy, specifier, targetName) {
  return (
    matchesPolicyTarget(policy, specifier) ||
    (policy.forbidNodeBuiltins && isNodeBuiltin(specifier)) ||
    (targetName && policy.forbiddenWorkspacePackages.includes(targetName))
  );
}

function declaresDependency(owner, dependencyName) {
  return WORKSPACE_DEPENDENCY_FIELDS.some((field) => {
    const dependencies = owner.manifest[field];
    return (
      dependencies &&
      typeof dependencies === 'object' &&
      Object.hasOwn(dependencies, dependencyName)
    );
  });
}

function resolveRelativeModule(importerPath, specifier, repository) {
  const rawTarget = relativeImportPath(importerPath, specifier);
  if (!rawTarget) return undefined;
  const candidates = moduleCandidates(rawTarget);
  return candidates.find((candidate) => repository.has(candidate));
}

function relativeWorkspacePackage(importerPath, specifier, workspaces) {
  const rawTarget = relativeImportPath(importerPath, specifier);
  return rawTarget ? workspaceForPath(rawTarget, workspaces) : undefined;
}

function relativeImportPath(importerPath, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('\\')) return undefined;
  return normalizeRelativePath(
    posix.join(posix.dirname(importerPath), specifier.replaceAll('\\', '/')),
  );
}

function moduleCandidates(path) {
  const candidates = [path];
  const extension = extname(path);
  const extensionlessPath = MODULE_EXTENSIONS.includes(extension)
    ? path.slice(0, -extension.length)
    : path;

  for (const candidateExtension of MODULE_EXTENSIONS) {
    candidates.push(`${extensionlessPath}${candidateExtension}`);
  }
  for (const candidateExtension of MODULE_EXTENSIONS) {
    candidates.push(`${extensionlessPath}/index${candidateExtension}`);
  }

  return [...new Set(candidates)];
}

function workspaceForPath(path, workspaces) {
  if (!path) return undefined;
  const normalizedPath = normalizeRelativePath(path);
  return [...workspaces.values()]
    .filter(
      (workspace) =>
        normalizedPath === workspace.dir || normalizedPath.startsWith(`${workspace.dir}/`),
    )
    .sort((left, right) => right.dir.length - left.dir.length)[0];
}

function isPublicWorkspaceSubpath(workspace, subpath) {
  if (subpath === '') return true;
  if (subpath === './' || subpath === './src' || subpath.startsWith('./src/')) return false;

  const exports = workspace.manifest.exports;
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return false;

  return Object.keys(exports).some((exportKey) => {
    if (!exportKey.startsWith('./')) return false;
    if (exportKey === subpath) return true;
    if (!exportKey.endsWith('/*')) return false;
    return subpath.startsWith(exportKey.slice(0, -1));
  });
}

function checkWorkspaceCycles(workspaces, report) {
  const graph = new Map();
  for (const info of workspaces.values()) {
    const dependencies = new Set();
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      const values = info.manifest[field];
      if (!values || typeof values !== 'object') continue;
      for (const dependency of Object.keys(values)) {
        if (workspaces.has(dependency)) dependencies.add(dependency);
      }
    }
    graph.set(info.name, [...dependencies].sort());
  }

  const states = new Map();
  const stack = [];
  const reportedCycles = new Set();

  const visit = (name) => {
    states.set(name, 'visiting');
    stack.push(name);

    for (const dependency of graph.get(name) ?? []) {
      const state = states.get(dependency);
      if (!state) {
        visit(dependency);
        continue;
      }
      if (state !== 'visiting') continue;

      const cycleStart = stack.indexOf(dependency);
      const cycle = stack.slice(cycleStart);
      const canonical = canonicalCycle(cycle);
      const key = canonical.join('->');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        const firstWorkspace = workspaces.get(canonical[0]);
        report({
          ruleId: 'ARCH_WORKSPACE_CYCLE',
          file: firstWorkspace?.manifestPath ?? `${canonical[0]}/package.json`,
          target: [...canonical, canonical[0]].join(' -> '),
          message:
            'Production workspace dependencies must form an acyclic graph; split the ownership boundary instead of adding a runtime cycle.',
        });
      }
    }

    stack.pop();
    states.set(name, 'done');
  };

  for (const name of [...graph.keys()].sort()) {
    if (!states.has(name)) visit(name);
  }
}

function canonicalCycle(cycle) {
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return rotations.sort((left, right) => left.join('|').localeCompare(right.join('|')))[0];
}

function normalizeRelativePath(path) {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const violations = checkArchitecture();
    if (violations.length > 0) {
      console.error(`Architecture contract failed with ${violations.length} violation(s):`);
      for (const violation of violations) console.error(formatArchitectureViolation(violation));
      process.exitCode = 1;
    } else {
      console.log('Architecture contract passed (0 violations).');
    }
  } catch (error) {
    console.error(
      `Architecture checker failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
