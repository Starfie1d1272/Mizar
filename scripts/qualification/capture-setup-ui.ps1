param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SetupUI {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  public static IntPtr Window(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,p) => { uint id; GetWindowThreadProcessId(h,out id);
      if(id == processId && IsWindowVisible(h)) { found=h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr hwnd) { var text=new StringBuilder(4096); GetWindowText(hwnd,text,text.Capacity); return text.ToString(); }
  public static IntPtr Child(IntPtr parent, string text, string className = null) {
    IntPtr found=IntPtr.Zero;
    EnumChildWindows(parent, (h,p) => { var c=new StringBuilder(128); GetClassName(h,c,c.Capacity);
      if(IsWindowVisible(h) && (text == null || Text(h).Contains(text)) && (className == null || c.ToString() == className)) { found=h; return false; } return true; }, IntPtr.Zero);
    return found;
  }

}
'@
[SetupUI]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$process = Start-Process -FilePath $Installer -ArgumentList ('/D=' + $InstallDirectory) -PassThru
function Wait-UI([scriptblock]$Check, [string]$Stage) {
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  do {
    $result = & $Check
    if ($result -ne [IntPtr]::Zero) { return $result }
    if ($process.HasExited) { throw "Installer exited during $Stage" }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Installer timed out during $Stage"
}
function Click-Next {
  $button = [SetupUI]::GetDlgItem($window, 1)
  if (![SetupUI]::IsWindowEnabled($button)) { throw 'Installer button is disabled' }
  [SetupUI]::PostMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}
function Capture([string]$Stage) {
  Start-Sleep -Milliseconds 200
  $rect = New-Object SetupUI+Rect
  if (![SetupUI]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot measure installer' }
  $bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $dc = $graphics.GetHdc()
    try { $captured = [SetupUI]::PrintWindow($window, $dc, 2) } finally { $graphics.ReleaseHdc($dc) }
    if (!$captured) { throw 'Cannot capture native installer' }
    $bitmap.Save((Join-Path $OutputDirectory "$Stage.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
try {
  $window = Wait-UI { [SetupUI]::Window($process.Id) } 'welcome'
  Wait-UI { [SetupUI]::Child($window, '欢迎安装 Mizar') } 'welcome text' | Out-Null
  $dpi = [SetupUI]::GetDpiForWindow($window)
  Capture 'welcome'
  Click-Next
  Wait-UI { [SetupUI]::Child($window, '选择安装位置') } 'directory' | Out-Null
  Capture 'directory'
  Click-Next
  $tree = Wait-UI { [SetupUI]::Child($window, $null, 'SysTreeView32') } 'shortcuts'
  Capture 'shortcuts'
  # Native MUI component tree: Space toggles the optional desktop section.
  [SetupUI]::SendMessage($tree, 0x110B, [IntPtr](9), [SetupUI]::SendMessage($tree, 0x110A, [IntPtr](0), [IntPtr]::Zero)) | Out-Null
  [SetupUI]::SendMessage($tree, 0x102, [IntPtr](32), [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 200
  Click-Next
  Wait-UI { [SetupUI]::Child($window, $null, 'msctls_progress32') } 'progress' | Out-Null
  Capture 'progress'
  Wait-UI { [SetupUI]::Child($window, 'Mizar 已安装') } 'finish' | Out-Null
  Capture 'finish'
  Click-Next
  if (!$process.WaitForExit(30000) -or $process.ExitCode -ne 0) { throw 'Interactive installation failed' }
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  do {
    $app = Get-Process -Name Mizar -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $InstallDirectory 'Mizar.exe') }
    if ($app -and [SetupUI]::Window($app.Id) -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if (!$app -or [SetupUI]::Window($app.Id) -eq [IntPtr]::Zero) { throw 'Finish did not launch visible Mizar' }
  if (!(Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk'))) { throw 'Selected desktop shortcut missing' }
  $stop = Start-Process -FilePath (Join-Path $InstallDirectory 'Mizar.exe') -ArgumentList @('--stop', '--no-browser') -PassThru
  if (!$stop.WaitForExit(45000) -or $stop.ExitCode -ne 0) { throw 'Controlled stop failed' }
  if (!$app.WaitForExit(45000)) { throw 'Launched app survived controlled stop' }
  [ordered]@{
    installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
    os = [Environment]::OSVersion.VersionString
    dpi = $dpi; scalePercent = ($dpi / 96 * 100)
    interactiveInstall = 'PASS'; optionalShortcut = 'PASS'; finishLaunch = 'PASS'
    screenshots = @('welcome.png', 'directory.png', 'shortcuts.png', 'progress.png', 'finish.png')
    visualApproval = 'PENDING'; otherDpiScales = 'NOT RUN'
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.json') -Encoding utf8NoBOM
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
}
