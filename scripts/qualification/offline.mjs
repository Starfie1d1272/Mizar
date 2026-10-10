import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readAppVersion, windowsBundleName } from './app-version.mjs';
import { createBuildTimer } from './build-timings.mjs';
import { isDevelopmentFile } from './portable-files.mjs';
import { runPlatformContracts } from '../ci/platform-contracts.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function executable(command) {
  return process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command;
}

function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable(command), args, {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(new Error(`${command} ${args.join(' ')} 执行失败（${signal ?? `退出码 ${code}`}）`));
    });
  });
}

async function assertFile(path, label) {
  try {
    await access(path);
  } catch (error) {
    throw new Error(`qualification offline smoke 缺少 ${label}：${path}`, { cause: error });
  }
}

export async function assertPortableApp(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('qualification bundle 包含符号链接：' + path);
    if (entry.isFile() && isDevelopmentFile(entry.name))
      throw new Error('production 包仍包含开发文件：' + path);
    if (entry.isDirectory()) await assertPortableApp(path);
  }
}

export async function assertGsiScriptContract(scriptsDir) {
  const names = [
    'common.ps1',
    'gsi-discovery.ps1',
    'install-gsi.ps1',
    'gsi-status.ps1',
    'select-cs2-installation.ps1',
    'restore-gsi.ps1',
  ];
  const sources = new Map();
  for (const name of names) {
    const path = join(scriptsDir, name);
    await assertFile(path, name);
    sources.set(name, await readFile(path, 'utf8'));
  }
  for (const name of [
    'install-gsi.ps1',
    'gsi-status.ps1',
    'restore-gsi.ps1',
    'select-cs2-installation.ps1',
  ]) {
    const source = sources.get(name);
    const imports = new Set(
      Array.from(
        source.matchAll(/^\s*\.\s*\(\s*Join-Path\s+\$PSScriptRoot\s+['"]([^'"]+\.ps1)['"]\s*\)/gm),
        (match) => match[1],
      ),
    );
    const required =
      name === 'restore-gsi.ps1' ? ['common.ps1'] : ['common.ps1', 'gsi-discovery.ps1'];
    for (const dependency of required) {
      if (!imports.has(dependency)) throw new Error(`qualification ${name} 未加载 ${dependency}`);
    }
    for (const dependency of imports)
      await assertFile(join(scriptsDir, dependency), `${name} 依赖的 ${dependency}`);
    const resolver =
      name === 'select-cs2-installation.ps1' ? /\bResolve-Cs2Input\b/ : /\bResolve-CfgDirectory\b/;
    if (name !== 'restore-gsi.ps1' && !resolver.test(source))
      throw new Error(`qualification ${name} 未使用共享 GSI 目录发现`);
  }
  const discovery = sources.get('gsi-discovery.ps1');
  if (
    !/^\s*function\s+Resolve-CfgDirectory\b/m.test(discovery) ||
    !/^\s*function\s+Get-SteamLibraryRoots\b/m.test(discovery) ||
    !discovery.includes('libraryfolders.vdf')
  )
    throw new Error('qualification gsi-discovery.ps1 缺少 Steam library / CS2 目录发现');
  if (
    !/^\s*function\s+Write-GsiEndpointConflictWarning\b/m.test(sources.get('common.ps1')) ||
    !/^\s*function\s+Suspend-GsiEndpointConflicts\b/m.test(sources.get('common.ps1')) ||
    !/\bSuspend-GsiEndpointConflicts\b/.test(sources.get('install-gsi.ps1')) ||
    !/\bRestore-GsiEndpointConflicts\b/.test(sources.get('restore-gsi.ps1')) ||
    !/\bWrite-GsiEndpointConflictWarning\b/.test(sources.get('install-gsi.ps1'))
  )
    throw new Error('qualification GSI 安装缺少 endpoint 冲突检查');
}

export async function findBundleDirectory(outputRoot, appVersion) {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const bundleName = windowsBundleName(appVersion);
  const bundle = entries.find((entry) => entry.isDirectory() && entry.name === bundleName);
  const archive = entries.find((entry) => entry.isFile() && entry.name === `${bundleName}.zip`);
  if (bundle === undefined || archive === undefined)
    throw new Error('qualification build 未生成一个 bundle 目录和一个 ZIP');
  return join(outputRoot, bundle.name);
}

async function assertBundleSmoke(outputRoot) {
  const bundleDir = await findBundleDirectory(outputRoot, await readAppVersion());
  for (const relativePath of [
    'app/package.json',
    'app/dist/server.js',
    'app/node_modules',
    'app/node_modules/cs2parser/package.json',
    'app/node_modules/cs2parser/LICENSE',
    'app/node_modules/@bufbuild/protobuf/package.json',
    'runtime',
    'scripts/common.ps1',
    'scripts/gsi-discovery.ps1',
    'scripts/gsi-status.ps1',
    'scripts/select-cs2-installation.ps1',
    'scripts/install-gsi.ps1',
    'scripts/restore-gsi.ps1',
    'scripts/start-product.ps1',
    'scripts/stop-product.ps1',
    'scripts/start.ps1',
    'scripts/rotate.ps1',
    'scripts/mark.ps1',
    'scripts/check.ps1',
    'scripts/stop.ps1',
    'scripts/verify-evidence.mjs',
    'scripts/evidence/contract.mjs',
    'scripts/evidence/capture.mjs',
    'scripts/evidence/objective-timing.mjs',
    'scripts/evidence/production-gsi-config.json',
    'scripts/evidence/objective-timing-policy.json',
    'scripts/evidence/scenario.mjs',
    'scripts/evidence/checks.mjs',
    'scripts/evidence/integrity.mjs',
    'scripts/evidence/report.mjs',
    'scripts/evidence/qualification.mjs',
    'scripts/qualification-supervisor.mjs',
    'scripts/qualification-contract.json',
    'config/gamestate_integration_mizar.cfg.template',
    'config/mizar_observer.cfg',
    'metadata/artifact.json',
    'metadata/SHA256SUMS',
    'README.txt',
  ])
    await assertFile(
      join(bundleDir, relativePath === 'README.txt' ? relativePath : 'resources/' + relativePath),
      relativePath,
    );
  for (const name of ['data', 'logs', 'evidence'])
    await assertFile(join(bundleDir, 'state', name), name);
  await assertPortableApp(join(bundleDir, 'resources/app'));
  const artifact = JSON.parse(
    await readFile(join(bundleDir, 'resources/metadata/artifact.json'), 'utf8'),
  );
  const expectedSha = await new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(stderr)),
    );
  });
  if (artifact.gitSha !== expectedSha)
    throw new Error('qualification artifact 的 git SHA 未绑定到当前 HEAD');
  const contract = JSON.parse(
    await readFile(join(rootDir, 'apps/companion/src/qualification/contract.json'), 'utf8'),
  );
  if (
    artifact.platform !== 'win32-x64' ||
    artifact.productSchemaVersion !== 1 ||
    !artifact.developmentOnly ||
    artifact.qualificationSchemaVersion !== contract.schemaVersion ||
    artifact.nodeVersion !== contract.nodeRuntimeVersion ||
    !contract.resetEvidenceFields?.includes('programTelemetryCleared') ||
    !contract.markerKinds?.includes('cs2-closed') ||
    contract.markerKinds?.includes('demo-a-stopped')
  )
    throw new Error('qualification artifact metadata 无效');
  const deployedPackage = await readFile(join(bundleDir, 'resources/app/package.json'), 'utf8');
  if (deployedPackage.includes('/Users/') || deployedPackage.includes('\\Users\\'))
    throw new Error('qualification deploy 包含绑定主机的绝对工作区路径');
  const config = await readFile(
    join(bundleDir, 'resources/config/gamestate_integration_mizar.cfg.template'),
    'utf8',
  );
  if (!config.includes('REPLACE_WITH_GSI_TOKEN'))
    throw new Error('qualification 配置模板缺少 token 占位符');
  if (
    !(await readFile(join(bundleDir, 'resources/config/mizar_observer.cfg'))).equals(
      await readFile(join(rootDir, 'config/mizar_observer.cfg')),
    )
  )
    throw new Error('观战 CFG 与固定源文件不一致');
  const scripts = await readFile(join(bundleDir, 'resources/scripts/start.ps1'), 'utf8');
  await assertGsiScriptContract(join(bundleDir, 'resources/scripts'));
  const readme = await readFile(join(bundleDir, 'README.txt'), 'utf8');
  if (
    !scripts.includes('runtime\\node.exe') ||
    !scripts.includes('MIZAR_COMMIT') ||
    !scripts.includes('supervisorProcessId') ||
    readme.includes('stopdemo') ||
    readme.includes('This bundle') ||
    !readme.includes('正常制作') ||
    !readme.includes('quit') ||
    !readme.includes('rotate.ps1')
  )
    throw new Error('qualification 启动脚本不满足可移植性检查');
}

export function offlineChecks(args) {
  const allowed = ['--quality-owned-static-checks', '--platform-only'];
  if (new Set(args).size !== args.length || args.some((arg) => !allowed.includes(arg)))
    throw new Error(
      'offline qualification accepts only --quality-owned-static-checks and --platform-only',
    );
  const qualityOwnedStaticChecks = args.includes('--quality-owned-static-checks');
  const platformOnly = args.includes('--platform-only');
  if (platformOnly && !qualityOwnedStaticChecks)
    throw new Error(
      '--platform-only requires --quality-owned-static-checks and a required Quality lane',
    );
  return {
    qualityOwnedStaticChecks,
    platformOnly,
    commands: [
      ...(qualityOwnedStaticChecks ? [] : ['format:check', 'lint', 'architecture:check']),
      'typecheck',
      ...(platformOnly ? [] : ['test']),
      'build',
    ],
  };
}

async function main() {
  const { qualityOwnedStaticChecks, platformOnly, commands } = offlineChecks(process.argv.slice(2));
  const temporaryParent = join(rootDir, '.agent-tmp');
  const evidence = join(temporaryParent, 'offline-evidence');
  await mkdir(evidence, { recursive: true });
  const timed = createBuildTimer(evidence, {
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
    platform: process.platform,
    qualityOwnedStaticChecks,
    platformOnly,
  });
  // CI's required Quality lane owns identical-source static checks. Standalone
  // callers keep them. Reduced mode requires that owner and retains host types,
  // builds and real OS-sensitive consumers before packaging the local outputs.
  for (const command of commands) await timed(command, () => runCommand('pnpm', [command]));
  if (platformOnly)
    await timed('platform-contracts', () =>
      runPlatformContracts(join(evidence, 'platform-contracts')),
    );

  const outputRoot = await mkdtemp(join(temporaryParent, 'qualification-offline-'));
  try {
    await timed('portable-bundle', () =>
      runCommand('node', [
        'scripts/qualification/build.mjs',
        '--skip-build',
        '--skip-node-runtime',
        '--allow-dirty',
        '--output',
        outputRoot,
      ]),
    );
    await timed('portable-integrity', () => assertBundleSmoke(outputRoot));
    console.log('QUALIFICATION_OFFLINE_PASS');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `QUALIFICATION_OFFLINE_ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
