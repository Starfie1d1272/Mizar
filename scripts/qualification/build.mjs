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
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import qualificationContract from '../../apps/companion/src/qualification/contract.json' with { type: 'json' };
import { QUALIFICATION_NODE_VERSION } from './runtime-config.mjs';

const REPOSITORY = 'Starfie1d1272/Mizar';
const QUALIFICATION_SCHEMA_VERSION = qualificationContract.schemaVersion;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return [
    '用法：node scripts/qualification/build.mjs [options]',
    '  --output <directory>       输出目录（默认：.agent-tmp/qualification-build）',
    '  --skip-build               复用已有 dist 输出',
    '  --skip-node-runtime        仅做结构 smoke 的 bundle，不是现场验收 artifact',
    '  --allow-dirty               本地开发时允许存在未提交的源代码变更',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    output: join(rootDir, '.agent-tmp', 'qualification-build'),
    nodeVersion: QUALIFICATION_NODE_VERSION,
    skipBuild: false,
    skipNodeRuntime: false,
    allowDirty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-build') options.skipBuild = true;
    else if (argument === '--skip-node-runtime') options.skipNodeRuntime = true;
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--output') {
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
  const sumsResponse = await fetchResponse(`${baseUrl}/SHASUMS256.txt`);
  const sums = await sumsResponse.text();
  const sumLine = sums
    .split(/\r?\n/)
    .find(
      (line) => line.trim().endsWith(` ${archiveName}`) || line.trim().endsWith(`*${archiveName}`),
    );
  const expectedHash = sumLine?.trim().split(/\s+/)[0];
  if (expectedHash === undefined || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error(`缺少 ${archiveName} 的官方 SHA-256`);
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
  await cp(extractedRoot, runtimeDir, { recursive: true, force: true });
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

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of (await import('node:fs')).createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function contentDigest(bundleDir) {
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

async function pruneDependencyTestFiles(appDir) {
  const developmentDirectories = new Set(['test', 'tests', '__tests__']);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (developmentDirectories.has(entry.name)) {
        await rm(path, { recursive: true, force: true });
      } else {
        await visit(path);
      }
    }
  }
  await visit(join(appDir, 'node_modules'));
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

async function writeShaSums(bundleDir) {
  const sumsPath = join(bundleDir, 'resources', 'metadata', 'SHA256SUMS');
  const files = await listFiles(bundleDir, new Set(['resources/metadata/SHA256SUMS', 'state']));
  const lines = [];
  for (const path of files)
    lines.push(`${await sha256File(path)}  ${relative(bundleDir, path).replaceAll('\\', '/')}`);
  await writeFile(sumsPath, `${lines.join('\n')}\n`, 'utf8');
}

async function createArchive(bundleDir, outputRoot, bundleName) {
  const archivePath = join(outputRoot, `${bundleName}.zip`);
  if (process.platform === 'win32') {
    await runCommand('tar', ['-a', '-c', '-f', archivePath, '-C', outputRoot, bundleName]);
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
  const bundleName = `mizar-${shortSha}-win-x64`;
  await mkdir(options.output, { recursive: true });
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
  if (!options.skipBuild) await runCommand('pnpm', ['build']);
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
    await createDeployWorkspace(deployWorkspaceDir);
    await runCommand(
      'pnpm',
      ['--filter', '@mizar/companion', 'deploy', deployedAppDir, '--prod', '--node-linker=hoisted'],
      { cwd: deployWorkspaceDir },
    );
    await cp(deployedAppDir, appDir, { recursive: true, dereference: true });
    await pruneDependencyTestFiles(appDir);
    await rm(deployedAppDir, { recursive: true, force: true });
    await restorePortableWorkspaceDependencySpecifiers(appDir);
    await cp(join(rootDir, 'apps', 'web', 'dist'), join(resourcesDir, 'web', 'dist'), {
      recursive: true,
      dereference: true,
    });
    const nodeVersion = options.skipNodeRuntime
      ? QUALIFICATION_NODE_VERSION
      : await downloadNodeRuntime(join(resourcesDir, 'runtime'), options.nodeVersion, downloadDir);
    for (const name of [
      'start-product.ps1',
      'stop-product.ps1',
      'common.ps1',
      'install-gsi.ps1',
      'restore-gsi.ps1',
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
    const developmentOnly =
      options.allowDirty || options.skipNodeRuntime || process.platform !== 'win32';
    if (process.platform === 'win32' && !options.skipNodeRuntime) {
      const desktopDir = join(rootDir, 'apps', 'desktop', 'src-tauri');
      await runCommand('cargo', [
        'build',
        '--release',
        '--locked',
        '--manifest-path',
        join(desktopDir, 'Cargo.toml'),
      ]);
      await cp(
        join(desktopDir, 'target', 'release', 'mizar-desktop.exe'),
        join(stagingDir, 'Mizar.exe'),
      );
    } else if (!options.skipNodeRuntime) {
      throw new Error(
        '正式产品包需要在 Windows x64 构建 EXE；本机结构检查请使用 --skip-node-runtime',
      );
    }
    const buildTimestamp = new Date().toISOString();
    const digest = await contentDigest(stagingDir);
    const artifact = {
      schemaVersion: 1,
      productSchemaVersion: 1,
      desktopHost: 'tauri2',
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
    await writeShaSums(stagingDir);

    await rename(stagingDir, bundleDir);
    await rm(stagingParent, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
    const archive = await createArchive(bundleDir, options.output, bundleName);
    console.log(
      JSON.stringify({
        bundleDir,
        archivePath: archive.archivePath,
        archiveSha256: archive.archiveSha256,
        artifactSha256: digest,
        gitSha,
        nodeVersion,
      }),
    );
  } catch (error) {
    await rm(stagingParent, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(
    `QUALIFICATION_BUILD_ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
