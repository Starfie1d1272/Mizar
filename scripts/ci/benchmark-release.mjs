import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// Research only: no attestation, release upload, profile edit or cache write.
if (process.platform !== 'win32') throw new Error('Release benchmark requires Windows');
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, '.agent-tmp/release-benchmark');
const qualification = join(root, 'scripts/qualification');
const target = join(root, 'apps/desktop/src-tauri/target/release');
const source = join(root, 'apps/desktop/src-tauri/src/main.rs');
const sourceStat = await stat(source);
const rows = [];
const identity = {
  gitSha: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  runner: process.env.RUNNER_OS,
  rust: spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout.trim(),
  node: process.version,
  promotable: false,
};
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`${command} failed: ${result.status}`);
};
async function measure(name, operation) {
  const row = { name, status: 'FAIL' };
  rows.push(row);
  const start = performance.now();
  try {
    Object.assign(row, await operation());
    row.status = 'PASS';
  } finally {
    row.seconds = (performance.now() - start) / 1000;
    await writeFile(join(output, 'benchmark.json'), JSON.stringify({ ...identity, rows }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `- ${name}: ${row.seconds.toFixed(2)}s (${row.status})\n`,
      );
  }
}
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const cargoArgs = [
  '--locked',
  '--profile',
  'release',
  '--manifest-path',
  'apps/desktop/src-tauri/Cargo.toml',
];
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
let fullPayload;
try {
  for (const [name, env] of [
    [
      'full-lto-cgu1',
      { CARGO_PROFILE_RELEASE_LTO: 'true', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1' },
    ],
    [
      'thin-lto-cgu16',
      { CARGO_PROFILE_RELEASE_LTO: 'thin', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16' },
    ],
  ]) {
    // Same runner/toolchain/source, fresh target for each profile; registry may be warm.
    await rm(target, { recursive: true, force: true });
    const area = join(output, name);
    await measure(`${name}/cold-bundle`, async () => {
      run(
        process.execPath,
        ['scripts/qualification/build.mjs', '--skip-build', '--output', area],
        env,
      );
      const manifest = JSON.parse(await readFile(join(area, 'release-manifest.json'), 'utf8'));
      const bundle = join(area, manifest.archive.slice(0, -4));
      if (
        manifest.gitSha !== identity.gitSha ||
        manifest.desktopBuildProfile !== 'release' ||
        manifest.developmentOnly
      )
        throw new Error('Benchmark bundle identity mismatch');
      if (!fullPayload) fullPayload = { bundle, area };
      const timings = JSON.parse(await readFile(join(area, 'build-timings.json'), 'utf8'));
      return {
        env,
        phases: timings.phases,
        exeBytes: (await stat(join(bundle, 'Mizar.exe'))).size,
        exeSha256: await digest(join(bundle, 'Mizar.exe')),
        archiveSha256: manifest.archiveSha256,
      };
    });
    await measure(`${name}/native-smoke`, async () => {
      const manifest = JSON.parse(await readFile(join(area, 'release-manifest.json'), 'utf8'));
      const extracted = join(area, 'shell extracted path');
      run('pwsh', [
        '-NoProfile',
        '-File',
        join(qualification, 'extract-windows-shell.ps1'),
        '-Archive',
        join(area, manifest.archive),
        '-Destination',
        extracted,
      ]);
      const bundle = join(extracted, manifest.archive.slice(0, -4));
      run(process.execPath, ['scripts/qualification/product-smoke.mjs', bundle]);
      run(process.execPath, [
        'scripts/qualification/desktop-smoke.mjs',
        bundle,
        join(area, 'desktop-smoke.json'),
      ]);
      run(process.execPath, [
        'scripts/qualification/product-soak.mjs',
        bundle,
        join(area, 'host-soak.json'),
      ]);
      run(process.execPath, [
        'scripts/qualification/verify-promotion.mjs',
        area,
        extracted,
        `v${manifest.appVersion}`,
        identity.gitSha,
        join(area, 'identity.json'),
      ]);
      return { desktop: JSON.parse(await readFile(join(area, 'desktop-smoke.json'), 'utf8')) };
    });
    await measure(`${name}/warm-host-rebuild`, async () => {
      await utimes(source, new Date(), new Date());
      run('cargo', ['build', ...cargoArgs], env);
      return { env, exeBytes: (await stat(join(target, 'mizar-desktop.exe'))).size };
    });
    await measure(`${name}/rust-contracts`, async () => {
      run('cargo', ['test', ...cargoArgs], env);
    });
  }

  const nsi = await readFile(join(qualification, 'windows-setup.nsi'), 'utf8');
  const setup = await readFile(join(qualification, 'create-windows-setup.ps1'), 'utf8');
  if (nsi.split('SetCompressor /SOLID lzma').length !== 2)
    throw new Error('Unknown compressor baseline');
  // Refuse stale instrumentation instead of silently measuring the unchanged
  // baseline after the production verifier changes.
  for (const marker of [
    '& $compiler /INPUTCHARSET',
    'function Install-Setup {',
    "$script = Join-Path $PSScriptRoot 'windows-setup.nsi'",
  ]) {
    if (setup.split(marker).length !== 2)
      throw new Error(`Unknown installer verifier marker: ${marker}`);
  }
  const quote = (s) => `'${s.replaceAll("'", "''")}'`;
  for (const [name, compressor] of [
    ['solid-lzma', 'SetCompressor /SOLID lzma'],
    ['lzma', 'SetCompressor lzma'],
    ['zlib', 'SetCompressor zlib'],
  ]) {
    const area = join(output, `nsis-${name}`);
    await mkdir(area);
    await cp(join(fullPayload.area, 'release-manifest.json'), join(area, 'release-manifest.json'));
    const script = join(area, 'windows-setup.nsi');
    await writeFile(script, nsi.replace('SetCompressor /SOLID lzma', compressor));
    // Invoke the existing lifecycle verifier with a temporary compiler input.
    // Its original asset/license/hash checks, install/reinstall/uninstall and
    // user-data preservation remain the oracle for every compression variant.
    const verifier = setup
      .replace(
        '& $compiler /INPUTCHARSET',
        '$compilerTimer = [Diagnostics.Stopwatch]::StartNew()\n& $compiler /INPUTCHARSET',
      )
      .replace(
        'function Install-Setup {',
        `$compilerTimer.Stop()\n$compilerTimer.Elapsed.TotalSeconds | Set-Content -LiteralPath ${quote(join(area, 'nsis-compile-seconds.txt'))}\nfunction Install-Setup {`,
      )
      .replaceAll('$PSScriptRoot', quote(qualification))
      .replace(
        `$script = Join-Path ${quote(qualification)} 'windows-setup.nsi'`,
        `$script = ${quote(script)}`,
      );
    const entry = join(area, 'create-windows-setup.ps1');
    await writeFile(entry, verifier);
    const installed = join(area, 'installed path');
    await measure(`nsis-${name}/compile-and-lifecycle`, async () => {
      run('pwsh', [
        '-NoProfile',
        '-File',
        entry,
        '-BundleRoot',
        fullPayload.bundle,
        '-OutputRoot',
        area,
        '-ExtractRoot',
        installed,
      ]);
      const distribution = JSON.parse(
        await readFile(join(area, 'distribution-manifest.json'), 'utf8'),
      );
      return {
        compressor,
        compilerSeconds: Number(await readFile(join(area, 'nsis-compile-seconds.txt'), 'utf8')),
        bytes: distribution.archiveBytes,
        sha256: distribution.archiveSha256,
        contentDigest: distribution.contentDigest,
        originalArchiveSha256: distribution.originalArchiveSha256,
        verifiedFiles: distribution.verifiedFiles,
      };
    });
    const bundle = join(installed, fullPayload.bundle.split(/[\\/]/).at(-1));
    await measure(`nsis-${name}/installed-smoke`, async () => {
      run(process.execPath, ['scripts/qualification/product-smoke.mjs', bundle]);
      run(process.execPath, [
        'scripts/qualification/desktop-smoke.mjs',
        bundle,
        join(area, 'desktop-smoke.json'),
      ]);
    });
    run('pwsh', [
      '-NoProfile',
      '-Command',
      `$p = Start-Process -FilePath ${quote(join(bundle, 'Uninstall.exe'))} -ArgumentList @('/S', ${quote('_?=' + bundle)}) -PassThru -Wait; if ($p.ExitCode -ne 0) { throw 'Benchmark cleanup failed' }`,
    ]);
  }
} finally {
  await utimes(source, sourceStat.atime, sourceStat.mtime);
  await writeFile(join(output, 'benchmark.json'), JSON.stringify({ ...identity, rows }, null, 2));
}
