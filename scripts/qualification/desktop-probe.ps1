# Test-only Win32 observer. It never loads code into Mizar or changes its lifecycle.
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][uint32]$DriverProcessId
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MizarDesktopProbe {
    public delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    public class Window {
        public long hwnd;
        public string title;
        public string className;
        public int width;
        public int height;
        public uint? captureAffinity;
    }
    public class ConsoleResult {
        public uint pid;
        public long hwnd;
        public bool visible;
        public int attachError;
        public bool processExited;
    }
    [DllImport("user32.dll")]
    static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")]
    static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")]
    static extern bool FreeConsole();
    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();

    public static Window[] Windows(uint processId) {
        var result = new List<Window>();
        EnumWindows((hwnd, data) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId || !IsWindowVisible(hwnd)) return true;
            var title = new StringBuilder(512);
            var className = new StringBuilder(256);
            GetWindowText(hwnd, title, title.Capacity);
            GetClassName(hwnd, className, className.Capacity);
            Rect rect;
            GetClientRect(hwnd, out rect);
            uint affinity;
            uint? captureAffinity = GetWindowDisplayAffinity(hwnd, out affinity) ? (uint?)affinity : null;
            result.Add(new Window { hwnd = hwnd.ToInt64(), title = title.ToString(),
                className = className.ToString(), width = rect.Right - rect.Left,
                height = rect.Bottom - rect.Top, captureAffinity = captureAffinity });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    // A console HWND normally belongs to conhost, not node.exe. Attach from this
    // separate probe process so the smoke runner keeps its own console untouched.
    public static ConsoleResult Console(uint processId) {
        FreeConsole();
        var result = new ConsoleResult { pid = processId };
        if (!AttachConsole(processId)) {
            result.attachError = Marshal.GetLastWin32Error();
            return result;
        }
        try {
            var hwnd = GetConsoleWindow();
            result.hwnd = hwnd.ToInt64();
            result.visible = hwnd != IntPtr.Zero && IsWindowVisible(hwnd);
            return result;
        } finally { FreeConsole(); }
    }

    public static void DismissFailure(uint processId) {
        foreach (var window in Windows(processId)) {
            if (window.className == "#32770" && window.title == "Mizar \u542f\u52a8\u5931\u8d25") {
                // Standard native error dialog: choose No (exit), never WM_CLOSE
                // on the normal main window (which intentionally hides to tray).
                PostMessage(new IntPtr(window.hwnd), 0x0111, new IntPtr(7), IntPtr.Zero);
            }
        }
    }
}
'@

$tracked = @{}
$currentRoot = 0
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $line | ConvertFrom-Json
    $rootProcessId = [uint32]$request.rootProcessId
    if ($currentRoot -ne $rootProcessId) {
        $tracked = @{}
        $currentRoot = $rootProcessId
    }
    if ($request.action -eq 'dismiss-failure') {
        [MizarDesktopProbe]::DismissFailure($rootProcessId)
    }
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
    $byId = @{}
    foreach ($process in $all) { $byId[[uint32]$process.ProcessId] = $process }
    $root = $all | Where-Object { $_.ProcessId -eq $rootProcessId } | Select-Object -First 1
    if ($null -ne $root -and -not $tracked.ContainsKey($rootProcessId)) {
        $tracked[$rootProcessId] = $root.CreationDate.ToUniversalTime().ToString('o')
    }
    # A failed startup may orphan Companion before the first CIM sample sees its
    # short-lived wrapper. The exact extracted runtime path is unique to this
    # smoke; include every packaged Node except the Node running the smoke itself.
    foreach ($process in $all) {
        if ($process.ExecutablePath -eq $NodePath -and $process.ProcessId -ne $DriverProcessId) {
            $tracked[[uint32]$process.ProcessId] = $process.CreationDate.ToUniversalTime().ToString('o')
        }
    }
    do {
        $added = $false
        foreach ($process in $all) {
            $processId = [uint32]$process.ProcessId
            $parentProcessId = [uint32]$process.ParentProcessId
            if (-not $tracked.ContainsKey($processId) -and $tracked.ContainsKey($parentProcessId)) {
                # Child creation must not predate its tracked parent (PID reuse).
                $parent = $byId[$parentProcessId]
                if ($null -ne $parent -and
                    $parent.CreationDate.ToUniversalTime().ToString('o') -eq $tracked[$parentProcessId] -and
                    $process.CreationDate.ToUniversalTime().ToString('o') -ge $tracked[$parentProcessId]) {
                    $tracked[$processId] = $process.CreationDate.ToUniversalTime().ToString('o')
                    $added = $true
                }
            }
        }
    } while ($added)
    $alive = @($all | Where-Object {
        $tracked.ContainsKey([uint32]$_.ProcessId) -and
        $_.CreationDate.ToUniversalTime().ToString('o') -eq $tracked[[uint32]$_.ProcessId]
    })
    $nodes = @($alive | Where-Object { $_.ExecutablePath -eq $NodePath })
    $consoles = @($nodes | ForEach-Object {
        $node = $_
        $result = [MizarDesktopProbe]::Console($node.ProcessId)
        if ($result.attachError -eq 5) {
            # AttachConsole can report access denied while a process is exiting.
            # Re-query the original PID + creation time; a live target must still
            # fail inspection. Do not treat access denied alone as no console.
            $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $node.ProcessId) -Property ProcessId, CreationDate
            $result.processExited = $null -eq $current -or $current.CreationDate -ne $node.CreationDate
        }
        $result
    })
    $snapshot = [ordered]@{
        processes = @($alive | ForEach-Object {
            [ordered]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; name = $_.Name; packagedNode = $_.ExecutablePath -eq $NodePath }
        })
        windows = @([MizarDesktopProbe]::Windows($rootProcessId))
        consoles = $consoles
    }
    [Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Depth 6 -Compress))
}
