param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This experiment needs Windows, not emulated file sharing.' }
# A one-off branch-only experiment. No Mizar process, registry, known mutex, or
# user installation is touched. Every child exits itself within thirty seconds.
$root = Join-Path ([IO.Path]::GetTempPath()) ('mizar-handoff-probe-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$source = Join-Path $root 'update-install.ps1'
$archive = Join-Path $root 'update-install.ps1.retired'
$ready = Join-Path $root 'loaded'
$release = Join-Path $root 'release'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$children = [Collections.Generic.List[Diagnostics.Process]]::new()
$gate = $null
function Assert($condition, [string]$message) { if (!$condition) { throw $message } }
function Start-Fixture {
  $info = [Diagnostics.ProcessStartInfo]::new($powershell)
  $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $source + '" -Mode Recover -StageRoot "' + $root + '"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $child = [Diagnostics.Process]::Start($info)
  $children.Add($child)
  return $child
}
function Wait-Fixture($child) {
  Assert ($child.WaitForExit(40000)) 'Fixture did not exit within its own bounded lifetime; do not terminate it.'
  return $child.ExitCode
}
try {
  $original = @'
param([string]$Mode, [string]$StageRoot)
[IO.File]::WriteAllText((Join-Path $StageRoot 'loaded'), 'loaded original bytes')
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath (Join-Path $StageRoot 'release')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
exit 17
'@
  [IO.File]::WriteAllText($source, $original, [Text.UTF8Encoding]::new($false))
  $before = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  $loaded = Start-Fixture
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
  Assert (Test-Path -LiteralPath $ready) 'Fixture did not reach the parsed-script stage.'
  $snapshot = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $loaded.Id)
  Assert ($null -ne $snapshot) 'Live fixture was absent from Win32_Process.'
  Assert ($snapshot.ParentProcessId -eq $PID) 'Actual parent was not the launching PowerShell.'
  Assert ($snapshot.CommandLine.Contains('-StageRoot "' + $root + '"')) 'Actual StageRoot argument was unavailable.'
  Assert ([string]::Equals($snapshot.ExecutablePath, $powershell, [StringComparison]::OrdinalIgnoreCase)) 'Actual image was not Windows PowerShell.'
  # WMI serializes creation times at microsecond precision; the held process
  # handle exposes the original 100 ns creation time. Record the actual loss.
  $handle = $loaded.Handle
  $difference = [Math]::Abs($loaded.StartTime.ToUniversalTime().Ticks - $snapshot.CreationDate.ToUniversalTime().Ticks)
  Assert ($difference -lt 10) ('Creation identity differs beyond WMI precision: ' + $difference)
  Write-Output ('PASS actual image, parent, command line, held process handle, creation time; WMI loss ticks=' + $difference)

  $gate = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Delete)
  Assert (!$loaded.HasExited) 'Loaded fixture ended before the file exclusion check.'
  Write-Output 'PASS loaded PowerShell can remain active after an exclusive source handle is acquired; a file lock alone is NOT retirement'
  $late = Start-Fixture
  $lateCode = Wait-Fixture $late
  Assert ($lateCode -ne 17 -and $lateCode -ne 0) 'A late standard loader read old bytes through the exclusion handle.'
  Write-Output ('PASS late PowerShell loader denied while original path is excluded; exit=' + $lateCode)

  [IO.File]::WriteAllText($release, 'exit normally')
  Assert ((Wait-Fixture $loaded) -eq 17) 'Original fixture did not exit normally.'
  [IO.File]::Move($source, $archive)
  [IO.File]::WriteAllText($source, "Write-Error 'fixture_retired' -ErrorAction Continue`r`nexit 73`r`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::SetAttributes($source, [IO.FileAttributes]::ReadOnly)
  $gate.Dispose(); $gate = $null
  Assert ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $before) 'Archived script bytes changed.'
  $retired = Start-Fixture
  Assert ((Wait-Fixture $retired) -eq 73) 'Original execution path did not reject the stale invocation.'
  Write-Output 'PASS rename under FileShare.Delete, original bytes preserved, original path replaced by a read-only refusal'

  $leasePath = Join-Path $root 'fresh-install.lock'
  $lease = [IO.File]::Open($leasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $denied = $false
    try { $other = [IO.File]::Open($leasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $other.Dispose() } catch [IO.IOException] { $denied = $true }
    Assert $denied 'Competing bootstrap file lease was not excluded.'
  } finally { $lease.Dispose() }
  Write-Output 'PASS bootstrap file lease excludes a competing open without blocking or deleting its lock'
} finally {
  if ($gate) { $gate.Dispose() }
  [IO.File]::WriteAllText($release, 'exit normally')
  $allExited = $true
  foreach ($child in $children) {
    if (!$child.WaitForExit(40000)) { $allExited = $false }
    $child.Dispose()
  }
  if ($allExited) { Remove-Item -LiteralPath $root -Recurse -Force }
  else { Write-Warning 'A bounded fixture did not exit; retained its isolated directory. No process was killed.' }
}

# Named mutex owner inspection is a read-only NT query; verify the ABI before
# depending on it for a controlled parent/child writer handoff.
Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class HandoffMutexProbe {
  [StructLayout(LayoutKind.Sequential)] struct Owner { public IntPtr Process, Thread; }
  [DllImport("ntdll.dll")] static extern int NtQueryMutant(IntPtr handle, int kind, out Owner owner, int size, out int returned);
  public static int OwnerPid(string name) {
    using(var mutex = Mutex.OpenExisting(name)) {
      Owner owner; int returned;
      int result=NtQueryMutant(mutex.SafeWaitHandle.DangerousGetHandle(),1,out owner,Marshal.SizeOf(typeof(Owner)),out returned);
      if(result!=0 || returned!=Marshal.SizeOf(typeof(Owner))) throw new InvalidOperationException("NtQueryMutant status="+result+" size="+returned);
      return owner.Process.ToInt32();
    }
  }
}
'@
$name = 'Local\Mizar-Handoff-Probe-' + [guid]::NewGuid().ToString('N')
$mutex = [Threading.Mutex]::new($true, $name)
try {
  Assert ([HandoffMutexProbe]::OwnerPid($name) -eq $PID) 'NT mutex owner did not match the actual holding process.'
  $mutex.ReleaseMutex()
  Assert ([HandoffMutexProbe]::OwnerPid($name) -eq 0) 'Unowned mutex still reported an owner.'
  Write-Output 'PASS named mutex reports actual holding process and becomes unowned after release'
} finally { $mutex.Dispose() }
