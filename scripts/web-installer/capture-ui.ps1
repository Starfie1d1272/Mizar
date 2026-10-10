param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
$output = [IO.Path]::GetFullPath($OutputDirectory)
# Native screen capture of the actual executable. No HTML or synthetic UI is used.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
function Save-Window($process, $name) {
  $process.Refresh()
  $rect = New-Object CaptureWindow+Rect
  if (![CaptureWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { throw 'Native window unavailable' }
  [CaptureWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
  $bitmap = New-Object Drawing.Bitmap(($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
    $bitmap.Save((Join-Path $output $name), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

foreach ($state in @('installing','completed','start-failed')) {
  $demo = Start-Process -FilePath (Join-Path $output 'ui-state-demo.exe') -ArgumentList $state -PassThru
  try {
    if (!$demo.WaitForInputIdle(15000)) { throw 'UI demonstration did not become ready' }
    Start-Sleep -Milliseconds 500
    Save-Window $demo "native-ui-demo-$state.png"
  } finally { if (!$demo.HasExited) { $demo.CloseMainWindow() | Out-Null; if (!$demo.WaitForExit(5000)) { $demo.Kill() } } }
}
[ordered]@{ native=$true; uiStateFixture=$true; installationExecuted=$false; productionCompletionEvidence=$false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'native-ui-demo-evidence.json') -Encoding UTF8
