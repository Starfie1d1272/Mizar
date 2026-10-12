param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [ValidateSet('capture','capture-result','backup-unavailable','restore','cancel','close-blocked','close-completed')][string]$Action,
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
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Visit visitor, IntPtr parameter);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
 public class ChildInfo { public string Caption; public string ClassName; public long Handle; public bool Enabled; }
 public static ChildInfo[] Children(IntPtr parent) {
  var list=new System.Collections.Generic.List<ChildInfo>();
  EnumChildWindows(parent,delegate(IntPtr hwnd,IntPtr unused) {var text=new StringBuilder(256);var kind=new StringBuilder(256);GetWindowText(hwnd,text,256);GetClassName(hwnd,kind,256);list.Add(new ChildInfo {Caption=text.ToString(),ClassName=kind.ToString(),Handle=hwnd.ToInt64(),Enabled=IsWindowEnabled(hwnd)});return true;},IntPtr.Zero);
  return list.ToArray();
 }
 public static IntPtr Button(IntPtr parent,string caption) {
  IntPtr found=IntPtr.Zero;
  EnumChildWindows(parent,delegate(IntPtr hwnd,IntPtr unused) { var text=new StringBuilder(256); GetWindowText(hwnd,text,256); if(text.ToString()==caption) {found=hwnd;return false;}return true;},IntPtr.Zero);
  return found;
 }
 public static IntPtr Find(uint owner, string title) {
  IntPtr found=IntPtr.Zero;
  EnumWindows(delegate(IntPtr hwnd,IntPtr unused) { uint pid; GetWindowThreadProcessId(hwnd,out pid); var text=new StringBuilder(256); GetWindowText(hwnd,text,256); if(pid==owner && text.ToString()==title) { found=hwnd; return false; } return true; },IntPtr.Zero);
  return found;
 }
}
'@
$title = if ($Action -in @('close-completed','restore','capture-result','backup-unavailable')) { 'Mizar 更新结果' } else { 'Mizar 应用更新' }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$window = [IntPtr]::Zero
while ($window -eq [IntPtr]::Zero) {
 $window = [UpdateWindowProbe]::Find($ProcessId,$title)
 if ([DateTime]::UtcNow -gt $deadline) { throw 'Expected real update window not visible' }
 Start-Sleep -Milliseconds 50
}
if (![UpdateWindowProbe]::IsWindowVisible($window)) { throw 'Update window is hidden' }
function Invoke-Button($caption) {
 $handle = [UpdateWindowProbe]::Button($window,$caption)
 if ($handle -eq [IntPtr]::Zero -or ![UpdateWindowProbe]::IsWindowEnabled($handle)) { throw 'Expected an enabled native button' }
 $button = [Windows.Automation.AutomationElement]::FromHandle($handle)
 $patterns = @($button.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
 @{ name=$button.Current.Name; controlType=$button.Current.ControlType.ProgrammaticName; patterns=$patterns; nativeHandle=[long]$handle } | ConvertTo-Json -Compress | Write-Output
 $pattern = $null
 if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { ([Windows.Automation.InvokePattern]$pattern).Invoke(); return }
 if ($button.TryGetCurrentPattern([Windows.Automation.LegacyIAccessiblePattern]::Pattern,[ref]$pattern)) { ([Windows.Automation.LegacyIAccessiblePattern]$pattern).DoDefaultAction(); return }
 # BM_CLICK is the native button action, not a bypass of the handler or transaction.
 $result = [IntPtr]::Zero
 if ([UpdateWindowProbe]::SendMessageTimeout($handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero,2,1000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Native button action did not complete' }
}
$element = [Windows.Automation.AutomationElement]::FromHandle($window)
[UpdateWindowProbe]::Children($window) | ConvertTo-Json -Depth 3 | Write-Output
$cancel = [UpdateWindowProbe]::Button($window,'取消更新')
@{ buttonMissing=($cancel -eq [IntPtr]::Zero); nativeHandle=[long]$cancel; nativeEnabled=($cancel -ne [IntPtr]::Zero -and [UpdateWindowProbe]::IsWindowEnabled($cancel)) } | ConvertTo-Json -Compress | Write-Output
if ($cancel -ne [IntPtr]::Zero) { $observed=[Windows.Automation.AutomationElement]::FromHandle($cancel); @{ controlType=$observed.Current.ControlType.ProgrammaticName; isEnabled=$observed.Current.IsEnabled; patterns=@($observed.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) } | ConvertTo-Json -Compress | Write-Output }
if ($Action -eq 'restore') { $restore = [UpdateWindowProbe]::Button($window,'恢复旧版'); if ($restore -eq [IntPtr]::Zero -or ![UpdateWindowProbe]::IsWindowEnabled($restore)) { throw 'Verified recovery action is unavailable' } }
if ($Action -eq 'backup-unavailable') {
 $restoreCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'恢复旧版')
 $restoreButton = $element.FindFirst([Windows.Automation.TreeScope]::Descendants,$restoreCondition)
 if ([UpdateWindowProbe]::Button($window,'恢复旧版') -eq [IntPtr]::Zero -or [UpdateWindowProbe]::IsWindowEnabled([UpdateWindowProbe]::Button($window,'恢复旧版'))) { throw 'Unverified backup must disable recovery' }
 $downloadCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'下载正式安装包')
 if ($null -eq $element.FindFirst([Windows.Automation.TreeScope]::Descendants,$downloadCondition)) { throw 'Unavailable backup lacks a concrete download path' }
}
if ($Action -eq 'cancel') {
 if ($cancel -eq [IntPtr]::Zero -or ![UpdateWindowProbe]::IsWindowEnabled($cancel)) { throw 'Pre-install cancellation is unavailable' }
}
if ($Action -eq 'close-blocked') {
 if ($cancel -eq [IntPtr]::Zero) { throw 'Cancel button missing from the native window' }
 if ([UpdateWindowProbe]::IsWindowEnabled($cancel)) { throw 'Native cancellation button remains enabled during mutation' }
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
if ($Action -eq 'cancel') { Invoke-Button '取消更新' }
if ($Action -eq 'restore') { Invoke-Button '恢复旧版' }
if ($Action -eq 'close-completed') {
 [void][UpdateWindowProbe]::PostMessage($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
 $deadline = [DateTime]::UtcNow.AddSeconds(5)
 while ([UpdateWindowProbe]::IsWindow($window)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Completed window could not close' }; Start-Sleep -Milliseconds 50 }
}
