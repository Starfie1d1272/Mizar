param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [ValidateSet('cancel','close-blocked','close-completed')][string]$Action,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms,UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UpdateWindowProbe {
 public delegate bool Visit(IntPtr hwnd, IntPtr parameter);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] static extern bool EnumWindows(Visit visitor, IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
 public static IntPtr Find(uint owner, string title) {
  IntPtr found=IntPtr.Zero;
  EnumWindows(delegate(IntPtr hwnd,IntPtr unused) { uint pid; GetWindowThreadProcessId(hwnd,out pid); var text=new StringBuilder(256); GetWindowText(hwnd,text,256); if(pid==owner && text.ToString()==title) { found=hwnd; return false; } return true; },IntPtr.Zero);
  return found;
 }
}
'@
$title = if ($Action -eq 'close-completed') { 'Mizar 更新结果' } else { 'Mizar 应用更新' }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$window = [IntPtr]::Zero
while ($window -eq [IntPtr]::Zero) {
 $window = [UpdateWindowProbe]::Find($ProcessId,$title)
 if ([DateTime]::UtcNow -gt $deadline) { throw 'Expected real update window not visible' }
 Start-Sleep -Milliseconds 50
}
if (![UpdateWindowProbe]::IsWindowVisible($window)) { throw 'Update window is hidden' }
$element = [Windows.Automation.AutomationElement]::FromHandle($window)
$condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'取消更新')
$cancel = $element.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
if ($Action -eq 'cancel') {
 if ($null -eq $cancel -or !$cancel.Current.IsEnabled) { throw 'Pre-install cancellation is unavailable' }
}
if ($Action -eq 'close-blocked') {
 if ($null -eq $cancel -or $cancel.Current.IsEnabled) { throw 'Mutation must disable cancellation' }
 [void][UpdateWindowProbe]::PostMessage($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
 Start-Sleep -Milliseconds 200
 if (![UpdateWindowProbe]::IsWindow($window)) { throw 'Close interrupted the protected transaction' }
}
$names = @($element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
if ($Action -eq 'close-blocked' -and $names -notcontains '正在安装新版 Mizar') { throw 'The displayed phase does not reflect the actual installer wait' }
$rectangle = New-Object UpdateWindowProbe+Rect
if (![UpdateWindowProbe]::GetWindowRect($window,[ref]$rectangle)) { throw 'Native window rectangle unavailable' }
[void][UpdateWindowProbe]::SetForegroundWindow($window)
Start-Sleep -Milliseconds 200
$bitmap = New-Object Drawing.Bitmap(($rectangle.Right-$rectangle.Left),($rectangle.Bottom-$rectangle.Top))
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try { $graphics.CopyFromScreen($rectangle.Left,$rectangle.Top,0,0,$bitmap.Size); $bitmap.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png) }
finally { $graphics.Dispose(); $bitmap.Dispose() }
@{ realNativeWindow=$true; source='production update helper'; syntheticInstaller=$true; actualNSIS=$false; action=$Action; title=$title; names=$names } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($OutputPath+'.json') -Encoding UTF8
if ($Action -eq 'cancel') { ([Windows.Automation.InvokePattern]$cancel.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke() }
if ($Action -eq 'close-completed') {
 [void][UpdateWindowProbe]::PostMessage($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
 $deadline = [DateTime]::UtcNow.AddSeconds(5)
 while ([UpdateWindowProbe]::IsWindow($window)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Completed window could not close' }; Start-Sleep -Milliseconds 50 }
}
