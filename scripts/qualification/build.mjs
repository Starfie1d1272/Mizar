import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import qualificationContract from '../../apps/companion/src/qualification/contract.json' with { type: 'json' };
import { QUALIFICATION_NODE_VERSION } from './runtime-config.mjs';
import { copyNodeRuntime, pruneDevelopmentFiles } from './portable-files.mjs';
import { createBuildTimer } from './build-timings.mjs';
import { readAppVersion, windowsBundleName } from './app-version.mjs';

const REPOSITORY = 'Starfie1d1272/Mizar';
const QUALIFICATION_SCHEMA_VERSION = qualificationContract.schemaVersion;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return [
    '用法：node scripts/qualification/build.mjs [options]',
    '  --output <directory>       输出目录（默认：.agent-tmp/qualification-build）',
    '  --label <RC0|version>      可选报告名称，产品文件名由应用版本生成',
    '  --resource-mode <full|core-only>  Web 资源组装（默认：full；core-only 不可发布）',
    '  --skip-build               复用已有 dist 输出',
    '  --skip-node-runtime        仅做结构 smoke 的 bundle，不是现场验收 artifact',
    '  --desktop-profile <ci|release>  桌面 Host 构建 profile（默认：release）',
    '  --allow-dirty               本地开发时允许存在未提交的源代码变更',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    output: join(rootDir, '.agent-tmp', 'qualification-build'),
    nodeVersion: QUALIFICATION_NODE_VERSION,
    resourceMode: 'full',
    skipBuild: false,
    skipNodeRuntime: false,
    desktopProfile: 'release',
    allowDirty: false,
    label: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--resource-mode') {
      const value = argv[++index];
      if (!['full', 'core-only'].includes(value)) throw new Error('Invalid resource mode');
      options.resourceMode = value;
    } else if (argument === '--skip-build') options.skipBuild = true;
    else if (argument === '--skip-node-runtime') options.skipNodeRuntime = true;
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--desktop-profile') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${argument} 缺少值`);
      if (value !== 'ci' && value !== 'release') {
        throw new Error(`无效的桌面构建 profile：${value}（仅支持 ci 或 release）`);
      }
      options.desktopProfile = value;
      index += 1;
    } else if (argument === '--label') {
      const value = argv[++index];
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/.test(value)) {
        throw new Error('发布名称只能包含字母、数字、点和连字符，最多 40 字符');
      }
      options.label = value;
    } else if (argument === '--output') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${argument} 缺少值`);
      options.output = resolve(rootDir, value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}\n${usage()}`);
    }
  }
  return options;
}

function executable(command) {
  return process.platform === 'win32' && command === 'pnpm' ? 'pnpm.exe' : command;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const processHandle = spawn(executable(command), args, {
      cwd: options.cwd ?? rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      processHandle.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      processHandle.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }
    processHandle.once('error', reject);
    processHandle.once('exit', (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(' ')} 执行失败（${signal ?? `退出码 ${code}`}）\n${stderr}`,
          ),
        );
    });
  });
}

async function commandOutput(command, args, cwd = rootDir) {
  return (await runCommand(command, args, { cwd, capture: true })).stdout.trim();
}

async function ensureCleanCheckout(allowDirty) {
  if (allowDirty) return;
  const status = await commandOutput('git', ['status', '--porcelain']);
  if (status.length > 0) {
    console.error('QUALIFICATION_DIRTY_STATUS:\n' + status);
    throw new Error(
      `qualification build 要求工作区干净；仅限本地开发时使用 --allow-dirty\n${status}`,
    );
  }
}

async function fetchResponse(url) {
  const response = await globalThis.fetch(url);
  if (!response.ok || response.body === null)
    throw new Error(`下载失败：${url}（HTTP ${response.status}）`);
  return response;
}

function resolveNodeVersion(requested) {
  if (requested !== QUALIFICATION_NODE_VERSION) {
    throw new Error(
      `qualification 使用的 Node runtime 固定为 ${QUALIFICATION_NODE_VERSION}；请通过普通 PR 更新 runtime-config.mjs`,
    );
  }
  return QUALIFICATION_NODE_VERSION;
}

async function downloadNodeRuntime(runtimeDir, requestedVersion, temporaryDirectory) {
  const version = await resolveNodeVersion(requestedVersion);
  const archiveName = `node-${version}-win-x64.zip`;
  const baseUrl = `https://nodejs.org/dist/${version}`;
  const expectedHash = qualificationContract.nodeWinX64ArchiveSha256;
  if (expectedHash === undefined || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error(`缺少 ${archiveName} 的仓库固定 SHA-256`);
  const archivePath = join(temporaryDirectory, archiveName);
  const archiveResponse = await fetchResponse(`${baseUrl}/${archiveName}`);
  await pipeline(
    Readable.fromWeb(archiveResponse.body),
    createWriteStream(archivePath, { mode: 0o600 }),
  );
  const actualHash = await sha256File(archivePath);
  if (actualHash !== expectedHash)
    throw new Error(`Node runtime SHA-256 校验不一致：期望 ${expectedHash}，实际为 ${actualHash}`);
  const extractDir = join(temporaryDirectory, 'node-extract');
  await mkdir(extractDir);
  try {
    await runCommand('unzip', ['-q', archivePath, '-d', extractDir]);
  } catch (unzipError) {
    await runCommand('tar', ['-xf', archivePath, '-C', extractDir]).catch(() => {
      throw unzipError;
    });
  }
  const extractedRoot = join(extractDir, `node-${version}-win-x64`);
  await copyNodeRuntime(extractedRoot, runtimeDir);
  await access(join(runtimeDir, 'node.exe'));
  return version;
}

async function listFiles(root, ignored = new Set()) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      if (ignored.has(relativePath)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files.sort((a, b) => {
    const left = relative(root, a).replaceAll('\\', '/');
    const right = relative(root, b).replaceAll('\\', '/');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of (await import('node:fs')).createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function contentDigest(bundleDir) {
  const files = await listFiles(
    bundleDir,
    new Set(['resources/metadata/artifact.json', 'resources/metadata/SHA256SUMS', 'state']),
  );
  const hash = createHash('sha256');
  for (const path of files) {
    const digest = await sha256File(path);
    hash.update(`${relative(bundleDir, path).replaceAll('\\', '/')}\0${digest}\n`, 'utf8');
  }
  return hash.digest('hex');
}

async function createDeployWorkspace(workspaceDir) {
  await mkdir(workspaceDir, { recursive: true });
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(join(rootDir, name), join(workspaceDir, name));
  }
  for (const group of ['apps', 'packages']) {
    const sourceGroup = join(rootDir, group);
    const targetGroup = join(workspaceDir, group);
    await mkdir(targetGroup, { recursive: true });
    for (const entry of await readdir(sourceGroup, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourcePackage = join(sourceGroup, entry.name);
      try {
        await access(join(sourcePackage, 'package.json'));
      } catch {
        continue;
      }
      const targetPackage = join(targetGroup, entry.name);
      await mkdir(targetPackage, { recursive: true });
      await cp(join(sourcePackage, 'package.json'), join(targetPackage, 'package.json'));
      try {
        await cp(join(sourcePackage, 'dist'), join(targetPackage, 'dist'), {
          recursive: true,
          dereference: true,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function restorePortableWorkspaceDependencySpecifiers(appDir) {
  const deployedManifestPath = join(appDir, 'package.json');
  const sourceManifestPath = join(rootDir, 'apps', 'companion', 'package.json');
  const [deployedManifest, sourceManifest] = await Promise.all([
    readFile(deployedManifestPath, 'utf8').then((value) => JSON.parse(value)),
    readFile(sourceManifestPath, 'utf8').then((value) => JSON.parse(value)),
  ]);
  for (const [name, specifier] of Object.entries(sourceManifest.dependencies ?? {})) {
    if (specifier === 'workspace:*') deployedManifest.dependencies[name] = specifier;
  }
  await writeFile(deployedManifestPath, `${JSON.stringify(deployedManifest, null, 2)}\n`, 'utf8');
}

export async function writeShaSums(bundleDir) {
  const sumsPath = join(bundleDir, 'resources', 'metadata', 'SHA256SUMS');
  const files = await listFiles(bundleDir, new Set(['resources/metadata/SHA256SUMS', 'state']));
  const lines = [];
  for (const path of files)
    lines.push(`${await sha256File(path)}  ${relative(bundleDir, path).replaceAll('\\', '/')}`);
  await writeFile(sumsPath, `${lines.join('\n')}\n`, 'utf8');
}

export async function createArchive(bundleDir, outputRoot, bundleName) {
  const archivePath = join(outputRoot, `${bundleName}.zip`);
  if (process.platform === 'win32') {
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(scriptDir, 'create-windows-archive.ps1'),
      '-BundleRoot',
      bundleDir,
      '-ArchivePath',
      archivePath,
    ]);
  } else {
    await runCommand('zip', ['-q', '-r', archivePath, bundleName], { cwd: outputRoot });
  }
  return { archivePath, archiveSha256: await sha256File(archivePath) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureCleanCheckout(options.allowDirty);
  const gitSha = await commandOutput('git', ['rev-parse', 'HEAD']);
  const shortSha = gitSha.slice(0, 7);
  const appVersion = await readAppVersion();
  const bundleName = windowsBundleName(appVersion);
  await mkdir(options.output, { recursive: true });
  const timed = createBuildTimer(options.output, {
    gitSha,
    desktopBuildProfile: options.desktopProfile,
    cargoCache: {
      registry: process.env.MIZAR_CARGO_REGISTRY_CACHE_HIT ?? 'unknown',
      target: process.env.MIZAR_CARGO_TARGET_CACHE_HIT ?? 'unknown',
      resourceReused: process.env.MIZAR_RESOURCE_REUSED ?? 'unknown',
    },
  });
  const bundleDir = join(options.output, bundleName);
  const archivePath = join(options.output, `${bundleName}.zip`);
  for (const path of [bundleDir, archivePath]) {
    try {
      await access(path);
      throw new Error(`输出路径已存在：${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!options.skipBuild)
    await timed('workspace-build', () =>
      runCommand('pnpm', ['build'], { env: { MIZAR_WEB_RESOURCE_MODE: options.resourceMode } }),
    );
  await runCommand(process.execPath, [
    join(scriptDir, 'verify-web-resources.mjs'),
    join(rootDir, 'apps/web/dist'),
    options.resourceMode,
  ]);
  await access(join(rootDir, 'apps', 'companion', 'dist', 'server.js'));

  const stagingParent = await mkdtemp(join(options.output, '.staging-'));
  const stagingDir = join(stagingParent, bundleName);
  const deployWorkspaceDir = join(stagingParent, '.deploy-workspace');
  const deployedAppDir = join(stagingDir, '.deployed-app');
  const resourcesDir = join(stagingDir, 'resources');
  const appDir = join(resourcesDir, 'app');
  const downloadDir = await mkdtemp(join(options.output, '.node-runtime-'));
  try {
    await mkdir(join(resourcesDir, 'runtime'), { recursive: true });
    await mkdir(join(resourcesDir, 'scripts'), { recursive: true });
    await mkdir(join(resourcesDir, 'config'), { recursive: true });
    await mkdir(join(resourcesDir, 'metadata'), { recursive: true });
    for (const name of ['data', 'logs', 'evidence'])
      await mkdir(join(stagingDir, 'state', name), { recursive: true });
    for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
      await cp(join(rootDir, name), join(stagingDir, name));
    }
    await createDeployWorkspace(deployWorkspaceDir);
    await timed('deploy-production-dependencies', () =>
      runCommand(
        'pnpm',
        [
          '--filter',
          '@mizar/companion',
          'deploy',
          deployedAppDir,
          '--prod',
          '--node-linker=hoisted',
        ],
        { cwd: deployWorkspaceDir },
      ),
    );
    await cp(deployedAppDir, appDir, { recursive: true, dereference: true });
    // Keep dependency test directories: package entry points may reference them.
    await pruneDevelopmentFiles(appDir);
    await rm(deployedAppDir, { recursive: true, force: true });
    await restorePortableWorkspaceDependencySpecifiers(appDir);
    // The bridge resolves the registered package's public exports from Companion's
    // deployed node_modules. It remains absent until the real dependency is present.
    const hasResourceContract = await access(
      join(appDir, 'node_modules', '@mizar', 'resource-pack-contract', 'package.json'),
    ).then(
      () => true,
      (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (hasResourceContract) {
      const bridgeDirectory = join(appDir, 'dist', 'web-installer');
      await mkdir(bridgeDirectory, { recursive: true });
      for (const name of [
        'install-official-pack.mjs',
        'complete-bootstrap.mjs',
        'published-bootstrap.mjs',
        'resource-mirror.mjs',
        'installed-entry.mjs',
        'cancel-control.mjs',
      ]) {
        await cp(join(rootDir, 'scripts', 'web-installer', name), join(bridgeDirectory, name));
      }
    }
    await runCommand(process.execPath, [join(scriptDir, 'verify-c4-resources.mjs'), appDir]);
    await cp(join(rootDir, 'apps', 'web', 'dist'), join(resourcesDir, 'web', 'dist'), {
      recursive: true,
      dereference: true,
    });
    const nodeVersion = options.skipNodeRuntime
      ? QUALIFICATION_NODE_VERSION
      : await timed('node-runtime', () =>
          downloadNodeRuntime(join(resourcesDir, 'runtime'), options.nodeVersion, downloadDir),
        );
    for (const name of [
      'start-product.ps1',
      'stop-product.ps1',
      'common.ps1',
      'gsi-discovery.ps1',
      'gsi-status.ps1',
      'select-cs2-installation.ps1',
      'install-gsi.ps1',
      'ensure-gsi.ps1',
      'restore-gsi.ps1',
      'update-install.ps1',
      'start.ps1',
      'rotate.ps1',
      'mark.ps1',
      'check.ps1',
      'stop.ps1',
      'README.txt',
    ]) {
      await cp(
        join(scriptDir, 'bundle', name),
        name === 'README.txt' ? join(stagingDir, name) : join(resourcesDir, 'scripts', name),
      );
    }
    await cp(join(scriptDir, 'evidence.mjs'), join(resourcesDir, 'scripts', 'verify-evidence.mjs'));
    await cp(join(scriptDir, 'evidence'), join(resourcesDir, 'scripts', 'evidence'), {
      recursive: true,
    });
    await cp(
      join(rootDir, 'packages', 'telemetry-gsi', 'src', 'production-config.json'),
      join(resourcesDir, 'scripts', 'evidence', 'production-gsi-config.json'),
    );
    await cp(
      join(rootDir, 'packages', 'core', 'src', 'runtime', 'objective-timing-policy.json'),
      join(resourcesDir, 'scripts', 'evidence', 'objective-timing-policy.json'),
    );
    await cp(
      join(scriptDir, 'supervisor.mjs'),
      join(resourcesDir, 'scripts', 'qualification-supervisor.mjs'),
    );
    await cp(
      join(rootDir, 'apps', 'companion', 'src', 'qualification', 'contract.json'),
      join(resourcesDir, 'scripts', 'qualification-contract.json'),
    );
    await cp(
      join(rootDir, 'config', 'gamestate_integration_mizar.cfg.example'),
      join(resourcesDir, 'config', 'gamestate_integration_mizar.cfg.template'),
    );
    await cp(
      join(rootDir, 'config', 'mizar_observer.cfg'),
      join(resourcesDir, 'config', 'mizar_observer.cfg'),
    );
    await writeFile(
      join(stagingDir, 'README.txt'),
      `${await readFile(join(scriptDir, 'bundle', 'README.txt'), 'utf8')}`
        .replaceAll('<SHORT_SHA>', shortSha)
        .replaceAll('<NODE_VERSION>', nodeVersion),
      'utf8',
    );

    await cp(
      join(scriptDir, 'product-runtime.mjs'),
      join(resourcesDir, 'scripts', 'product-runtime.mjs'),
    );
    await cp(
      join(scriptDir, 'product-logs.mjs'),
      join(resourcesDir, 'scripts', 'product-logs.mjs'),
    );
    const developmentOnly =
      options.resourceMode === 'core-only' ||
      options.allowDirty ||
      options.skipNodeRuntime ||
      process.platform !== 'win32';
    if (process.platform === 'win32' && !options.skipNodeRuntime) {
      const desktopDir = join(rootDir, 'apps', 'desktop', 'src-tauri');
      await timed('desktop-cargo-build', () =>
        runCommand('cargo', [
          'build',
          '--profile',
          options.desktopProfile,
          '--locked',
          '--manifest-path',
          join(desktopDir, 'Cargo.toml'),
        ]),
      );
      await cp(
        join(desktopDir, 'target', options.desktopProfile, 'mizar-desktop.exe'),
        join(stagingDir, 'Mizar.exe'),
      );
    } else if (!options.skipNodeRuntime) {
      throw new Error(
        '正式产品包需要在 Windows x64 构建 EXE；本机结构检查请使用 --skip-node-runtime',
      );
    }
    if (process.platform === 'win32' && !options.skipNodeRuntime) {
      const compiledVersion = await commandOutput(join(stagingDir, 'Mizar.exe'), ['--app-version']);
      if (compiledVersion !== appVersion) throw new Error('EXE 编译版本与配置版本不一致');
    }
    const buildTimestamp = new Date().toISOString();
    const digest = await timed('content-digest', () => contentDigest(stagingDir));
    const artifact = {
      appVersion,
      resourceMode: options.resourceMode,
      webBytes: (
        await Promise.all(
          (await listFiles(join(resourcesDir, 'web', 'dist'))).map((path) =>
            stat(path).then((info) => info.size),
          ),
        )
      ).reduce((sum, size) => sum + size, 0),
      schemaVersion: 1,
      productSchemaVersion: 1,
      desktopHost: 'tauri2',
      desktopBuildProfile:
        process.platform === 'win32' && !options.skipNodeRuntime ? options.desktopProfile : null,
      developmentOnly,
      repository: REPOSITORY,
      gitSha,
      buildTimestamp,
      platform: 'win32-x64',
      nodeVersion,
      qualificationSchemaVersion: QUALIFICATION_SCHEMA_VERSION,
      artifactSha256: digest,
    };
    await writeFile(
      join(resourcesDir, 'metadata', 'artifact.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
    await timed('payload-checksums', () => writeShaSums(stagingDir));

    await rename(stagingDir, bundleDir);
    await rm(stagingParent, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
    const archive = await timed('zip-archive', () =>
      createArchive(bundleDir, options.output, bundleName),
    );
    await writeFile(
      `${archive.archivePath}.sha256`,
      `${archive.archiveSha256}  ${bundleName}.zip\n`,
    );
    await writeFile(
      join(options.output, 'release-manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appVersion: artifact.appVersion,
          resourceMode: options.resourceMode,
          webBytes: artifact.webBytes,
          label: options.label,
          archive: `${bundleName}.zip`,
          archiveSha256: archive.archiveSha256,
          gitSha,
          contentDigest: digest,
          nodeVersion,
          desktopBuildProfile: artifact.desktopBuildProfile,
          buildTimestamp,
          developmentOnly,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      JSON.stringify({
        bundleDir,
        archivePath: archive.archivePath,
        archiveSha256: archive.archiveSha256,
        artifactSha256: digest,
        gitSha,
        nodeVersion,
        desktopBuildProfile: artifact.desktopBuildProfile,
      }),
    );
  } catch (error) {
    await rm(stagingParent, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      `QUALIFICATION_BUILD_ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
