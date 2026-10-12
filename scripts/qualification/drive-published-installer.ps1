param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing,System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class InstallerCapture {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
$process=Start-Process -FilePath $Installer -PassThru
function Window {
 $process.Refresh()
 if($process.HasExited) { throw 'Published installer exited before completion' }
 if($process.MainWindowHandle -eq 0) { return $null }
 return [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}
function Elements($window) { $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) }
function Named($window,[string]$name,$type=$null) {
 $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
 if($type) {
  $kind=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,$type)
  $condition=New-Object Windows.Automation.AndCondition($condition,$kind)
 }
 return $window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function Capture([string]$name) {
 $process.Refresh();$rect=New-Object InstallerCapture+Rect
 if(![InstallerCapture]::GetWindowRect($process.MainWindowHandle,[ref]$rect)) { throw 'Installer window unavailable' }
 [InstallerCapture]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
 $bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bitmap.Save((Join-Path $Evidence $name),[Drawing.Imaging.ImageFormat]::Png) }
 finally { $graphics.Dispose();$bitmap.Dispose() }
}
$names=@()
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(30)
 do { $window=Window;if($window) { $entry=Named $window '安装位置' ([Windows.Automation.ControlType]::Edit);$button=Named $window '安装' ([Windows.Automation.ControlType]::Button) };if(!$entry -or !$button) { Start-Sleep -Milliseconds 100 } } while((!$entry -or !$button) -and [DateTime]::UtcNow -lt $deadline)
 if(!$entry -or !$button) { throw 'Actual installer controls unavailable' }
 $value=[Windows.Automation.ValuePattern]$entry.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
 $value.SetValue($Destination)
 Capture 'published-installer-before.png'
 ([Windows.Automation.InvokePattern]$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
 $deadline=[DateTime]::UtcNow.AddMinutes(12)
 $complete=$false
 do {
  $window=Window;$names=@((Elements $window) | ForEach-Object {$_.Current.Name})
  if($names -contains '安装完成') { $complete=$true;break }
  if($names -contains '安装未完成' -or $names -contains '无法继续安装' -or $names -contains '操作超时' -or $names -contains '需要恢复安装') { Capture 'published-installer-failed.png';throw ('Actual installer did not complete: '+($names -join '; ')) }
  Start-Sleep -Milliseconds 200
 } while([DateTime]::UtcNow -lt $deadline)
 if(!$complete) { throw 'Actual published installer completion timeout' }
 Capture 'published-installer-complete.png'
 [ordered]@{nativeExecutable=$true;fixture=$false;pid=$process.Id;destination=$Destination;completionObserved=$true;names=$names;launchMethod='close completed installer then explicit real Mizar --no-browser'} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Evidence 'installer-ui.json') -Encoding UTF8
 # Closing a finished window deliberately does not test the checked Finish launch option.
 $process.CloseMainWindow() | Out-Null
 if(!$process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'Completed native installer did not exit normally' }
} catch {
 [ordered]@{nativeExecutable=$true;fixture=$false;pid=$process.Id;names=$names;failure=$_.Exception.Message} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Evidence 'installer-ui-failure.json') -Encoding UTF8
 throw
}
