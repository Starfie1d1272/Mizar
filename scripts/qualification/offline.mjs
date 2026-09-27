import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('qualification bundle 包含符号链接：' + path);
    if (entry.isDirectory()) await assertNoSymlinks(path);
  }
}

async function assertBundleSmoke(outputRoot) {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const bundle = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('mizar-'));
  const archive = entries.find((entry) => entry.isFile() && entry.name.endsWith('.zip'));
  if (bundle === undefined || archive === undefined)
    throw new Error('qualification build 未生成一个 bundle 目录和一个 ZIP');
  const bundleDir = join(outputRoot, bundle.name);
  for (const relativePath of [
    'app/package.json',
    'app/dist/server.js',
    'app/node_modules',
    'app/node_modules/cs2parser/package.json',
    'app/node_modules/cs2parser/LICENSE',
    'app/node_modules/@bufbuild/protobuf/package.json',
    'runtime',
    'scripts/common.ps1',
    'scripts/install-gsi.ps1',
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
  await assertNoSymlinks(join(bundleDir, 'resources/app'));
  let hasDependencyTests = false;
  try {
    await access(join(bundleDir, 'resources/app/node_modules/@fastify/send/test'));
    hasDependencyTests = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (hasDependencyTests) throw new Error('production 包仍包含依赖测试夹具目录');
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
  const scripts = await readFile(join(bundleDir, 'resources/scripts/start.ps1'), 'utf8');
  const installer = await readFile(join(bundleDir, 'resources/scripts/install-gsi.ps1'), 'utf8');
  const readme = await readFile(join(bundleDir, 'README.txt'), 'utf8');
  if (
    !scripts.includes('runtime\\node.exe') ||
    !scripts.includes('MIZAR_COMMIT') ||
    !scripts.includes('supervisorProcessId') ||
    !installer.includes('libraryfolders.vdf') ||
    !installer.includes('GsiEndpointConflictWarning') ||
    readme.includes('stopdemo') ||
    readme.includes('This bundle') ||
    !readme.includes('正常制作') ||
    !readme.includes('quit') ||
    !readme.includes('rotate.ps1')
  )
    throw new Error('qualification 启动脚本不满足可移植性检查');
}

async function main() {
  for (const command of [
    ['format:check'],
    ['lint'],
    ['architecture:check'],
    ['typecheck'],
    ['test'],
    ['build'],
  ])
    await runCommand('pnpm', command);

  const temporaryParent = join(rootDir, '.agent-tmp');
  await mkdir(temporaryParent, { recursive: true });
  const outputRoot = await mkdtemp(join(temporaryParent, 'qualification-offline-'));
  try {
    await runCommand('node', [
      'scripts/qualification/build.mjs',
      '--skip-build',
      '--skip-node-runtime',
      '--allow-dirty',
      '--output',
      outputRoot,
    ]);
    await assertBundleSmoke(outputRoot);
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
