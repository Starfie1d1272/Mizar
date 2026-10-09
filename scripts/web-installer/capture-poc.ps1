param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
$output = [IO.Path]::GetFullPath($OutputDirectory)
$exe = Join-Path $output 'Mizar-WebInstaller-POC.exe'
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
$process = Start-Process -FilePath $exe -PassThru
try {
  if (!$process.WaitForInputIdle(15000)) { throw 'Native UI did not become ready' }
  Start-Sleep -Milliseconds 1000
  Save-Window $process 'native-ready.png'
  $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '开始验证')))
  if (!$button) { throw 'Start button missing' }
  # .NET Framework WinForms uses legacy accessibility; exercise the real keyboard action.
  [CaptureWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  [Windows.Forms.SendKeys]::SendWait("{ENTER}")
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $complete = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '下载验证完成')))
    $failed = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '下载未完成')))
  } while (!$complete -and !$failed -and (Get-Date) -lt $deadline)
  Save-Window $process 'native-result.png'
  if (!$complete) { throw 'Real anonymous HTTPS download did not complete' }
  $screen = [Drawing.Graphics]::FromHwnd($process.MainWindowHandle)
  $dpi = $screen.DpiX
  $screen.Dispose()
  [ordered]@{ dpi=$dpi; result='PASS'; os=[Environment]::OSVersion.VersionString; native=$true; appVersion='POC'; installationExecuted=$false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'native-evidence.json') -Encoding UTF8
} finally {
  if (!$process.HasExited) { $process.CloseMainWindow() | Out-Null; if (!$process.WaitForExit(5000)) { $process.Kill() } }
}
