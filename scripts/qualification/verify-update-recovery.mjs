// Windows v2 installer/applier/launcher controlled verification.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('此验证需要 Windows 环境与 mizar-applier.exe / mizar-launcher.exe');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const applierBin =
  process.env.MIZAR_APPLIER_BIN ??
  join(repoRoot, 'apps/desktop/installer/target/ci/mizar-applier.exe');
const launcherBin =
  process.env.MIZAR_LAUNCHER_BIN ??
  join(repoRoot, 'apps/desktop/installer/target/ci/mizar-launcher.exe');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function makeStubPayload(dir, { version, gitSha, exitCode = 0, signalReady = true }) {
  await mkdir(join(dir, 'resources/runtime'), { recursive: true });
  await mkdir(join(dir, 'resources/app/dist'), { recursive: true });
  await mkdir(join(dir, 'resources/web/dist'), { recursive: true });
  await mkdir(join(dir, 'resources/scripts'), { recursive: true });
  await mkdir(join(dir, 'resources/metadata'), { recursive: true });

  await cp(launcherBin, join(dir, 'mizar-launcher.exe'));
  await cp(applierBin, join(dir, 'mizar-applier.exe'));

  // PowerShell-compiled tiny C# stub for Mizar.exe (app-version, ready event, exit code)
  const stubSource = join(dir, '_stub.cs');
  const stubExe = join(dir, 'Mizar.exe');
  await writeFile(
    stubSource,
    `using System;
using System.Threading;
class Stub {
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--app-version") {
      Console.WriteLine("${version}");
      return 0;
    }
    var evName = Environment.GetEnvironmentVariable("MIZAR_UPDATE_READY_EVENT");
    if (!string.IsNullOrEmpty(evName) && ${signalReady ? 'true' : 'false'}) {
      try { using (var ev = EventWaitHandle.OpenExisting(evName)) { ev.Set(); } } catch {}
    }
    Thread.Sleep(50);
    return ${exitCode};
  }
}`,
  );
  const csc = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await exec(csc, ['/nologo', '/out:' + stubExe, stubSource]);
  await rm(stubSource, { force: true });

  await writeFile(join(dir, 'resources/runtime/node.exe'), 'stub-node');
  await writeFile(join(dir, 'resources/app/dist/server.js'), 'export {};\n');
  await writeFile(join(dir, 'resources/web/dist/index.html'), '<!doctype html>\n');
  await writeFile(join(dir, 'resources/scripts/product-runtime.mjs'), 'export {};\n');
  await writeFile(join(dir, 'resources/scripts/product-logs.mjs'), 'export {};\n');

  const files = [
    'Mizar.exe',
    'mizar-applier.exe',
    'mizar-launcher.exe',
    'resources/runtime/node.exe',
    'resources/app/dist/server.js',
    'resources/web/dist/index.html',
    'resources/scripts/product-runtime.mjs',
    'resources/scripts/product-logs.mjs',
  ].sort();

  const digest = createHash('sha256');
  const sumLines = [];
  for (const rel of files) {
    const h = sha256(await readFile(join(dir, rel)));
    sumLines.push(`${h}  ${rel}`);
    digest.update(`${rel}\0${h}\n`);
  }
  const contentDigest = digest.digest('hex');
  const artifact = {
    appVersion: version,
    resourceMode: 'full',
    schemaVersion: 1,
    productSchemaVersion: 1,
    desktopHost: 'tauri2',
    platform: 'win32-x64',
    developmentOnly: false,
    repository: 'Starfie1d1272/Mizar',
    gitSha,
    artifactSha256: contentDigest,
  };
  const artBytes = Buffer.from(JSON.stringify(artifact, null, 2) + '\n');
  await writeFile(join(dir, 'resources/metadata/artifact.json'), artBytes);
  sumLines.push(`${sha256(artBytes)}  resources/metadata/artifact.json`);
  sumLines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  await writeFile(join(dir, 'resources/metadata/SHA256SUMS'), sumLines.join('\n') + '\n');
  return contentDigest;
}

function exec(cmd, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const work = await mkdtemp(join(tmpdir(), 'mizar-v2-verify-'));
try {
  const stateRoot = join(work, 'state');
  const userMarker = join(stateRoot, 'matches', 'keep-me.txt');
  await mkdir(dirname(userMarker), { recursive: true });
  await writeFile(userMarker, 'user-data-intact');

  // 1. Fresh install into Chinese path
  const installDir = join(work, '工具', 'Mizar');
  const payload1 = join(work, 'payload1');
  const sha1 = 'a1b2c3d4'.repeat(5);
  const digest1 = await makeStubPayload(payload1, { version: '1.12.0', gitSha: sha1 });
  const res1 = join(work, 'res1.json');
  const r1 = await exec(applierBin, [
    'install',
    '--payload-dir',
    payload1,
    '--install-dir',
    installDir,
    '--state-root',
    stateRoot,
    '--expected-content-digest',
    digest1,
    '--no-ui',
    '--no-launch',
    '--result-file',
    res1,
  ]);
  assert.equal(r1.code, 0, r1.stderr);
  const ptr1 = JSON.parse(await readFile(join(installDir, 'current.json'), 'utf8'));
  assert.equal(ptr1.schemaVersion, 2);
  assert.equal(ptr1.current, '1.12.0-a1b2c3d4');
  const verOut = await exec(join(installDir, 'Mizar.exe'), ['--app-version']);
  assert.equal(verOut.code, 0);
  assert.equal(verOut.stdout.trim(), '1.12.0');

  // 2. Startup crash auto-rollback (v1.12.1 exits 1 before signaling ready -> rolls back to v1.12.0)
  const payload2 = join(work, 'payload2');
  const sha2 = 'e5f6a7b8'.repeat(5);
  const digest2 = await makeStubPayload(payload2, {
    version: '1.12.1',
    gitSha: sha2,
    exitCode: 1,
    signalReady: false,
  });
  const res2 = join(work, 'res2.json');
  const r2 = await exec(applierBin, [
    'install',
    '--payload-dir',
    payload2,
    '--install-dir',
    installDir,
    '--state-root',
    stateRoot,
    '--expected-content-digest',
    digest2,
    '--no-ui',
    '--result-file',
    res2,
  ]);
  assert.equal(r2.code, 16, r2.stderr);
  const ptr2 = JSON.parse(await readFile(join(installDir, 'current.json'), 'utf8'));
  assert.equal(ptr2.current, '1.12.0-a1b2c3d4');

  // 3. Successful update (v1.12.2 signals ready)
  const payload3 = join(work, 'payload3');
  const sha3 = '11223344'.repeat(5);
  const digest3 = await makeStubPayload(payload3, { version: '1.12.2', gitSha: sha3 });
  const r3 = await exec(applierBin, [
    'install',
    '--payload-dir',
    payload3,
    '--install-dir',
    installDir,
    '--state-root',
    stateRoot,
    '--expected-content-digest',
    digest3,
    '--no-ui',
  ]);
  assert.equal(r3.code, 0, r3.stderr);
  const ptr3 = JSON.parse(await readFile(join(installDir, 'current.json'), 'utf8'));
  assert.equal(ptr3.current, '1.12.2-11223344');

  // 4. Uninstall preserves user data
  const r4 = await exec(applierBin, [
    'uninstall',
    '--install-dir',
    installDir,
    '--state-root',
    stateRoot,
    '--no-ui',
  ]);
  assert.equal(r4.code, 0, r4.stderr);
  assert.equal(await readFile(userMarker, 'utf8'), 'user-data-intact');
  await assert.rejects(stat(join(installDir, 'current.json')));

  // 5. Capture real Windows rendered screenshots for each applier UI state
  const outDir = join(repoRoot, '.agent-tmp', 'update-window');
  await mkdir(outDir, { recursive: true });
  const captureScript = join(work, 'capture-applier-ui.ps1');
  await writeFile(
    captureScript,
    `param(
  [Parameter(Mandatory = $true)][string]$Applier,
  [Parameter(Mandatory = $true)][string]$State,
  [Parameter(Mandatory = $true)][string]$OutputPng
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ApplierSnap {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  public static IntPtr FindByPid(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint id;
      GetWindowThreadProcessId(h, out id);
      if (id == processId && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[ApplierSnap]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$proc = Start-Process -FilePath $Applier -ArgumentList @('preview', '--state', $State, '--hold-ms', '2200') -PassThru
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  $hwnd = [IntPtr]::Zero
  while ([DateTime]::UtcNow -lt $deadline) {
    $hwnd = [ApplierSnap]::FindByPid($proc.Id)
    if ($hwnd -ne [IntPtr]::Zero) { break }
    if ($proc.HasExited) { throw "Applier preview ($State) exited before window appeared" }
    Start-Sleep -Milliseconds 50
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw "Timed out waiting for applier preview window ($State)" }
  Start-Sleep -Milliseconds 350
  $rect = New-Object ApplierSnap+Rect
  if (![ApplierSnap]::GetWindowRect($hwnd, [ref]$rect)) { throw "GetWindowRect failed ($State)" }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -lt 400 -or $h -lt 160) { throw "Unexpected applier window size ($State): \${w}x\${h}" }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $dc = $g.GetHdc()
    try { $ok = [ApplierSnap]::PrintWindow($hwnd, $dc, 2) } finally { $g.ReleaseHdc($dc) }
    if (!$ok) { throw "PrintWindow failed ($State)" }
    $bmp.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
  if (!$proc.WaitForExit(5000)) { $proc.Kill() }
  Write-Output "Captured $State (\${w}x\${h}) -> $OutputPng"
} finally {
  if (!$proc.HasExited) { try { $proc.Kill() } catch {} }
}
`,
  );

  for (const state of ['verifying', 'commit', 'error', 'uninstall']) {
    const pngPath = join(outDir, `${state}.png`);
    const cap = await exec('pwsh', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      captureScript,
      '-Applier',
      applierBin,
      '-State',
      state,
      '-OutputPng',
      pngPath,
    ]);
    assert.equal(cap.code, 0, `capture ${state} failed: ${cap.stdout}\n${cap.stderr}`);
    const info = await stat(pngPath);
    assert.ok(info.size > 1000, `captured png too small for ${state}: ${info.size}`);
    console.log(cap.stdout.trim());
  }

  console.log('All Windows v2 installer/applier/launcher checks passed.');
} finally {
  await rm(work, { recursive: true, force: true });
}
