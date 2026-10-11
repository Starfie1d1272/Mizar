import { execFile } from 'node:child_process';

export interface ObsNativeProcess {
  readonly role: 'obs' | 'cs2';
  readonly pid: number;
  readonly startedAt: string | null;
  readonly elevated: boolean | null;
  readonly elevationError: number | null;
  readonly allowThirdParty: boolean | null;
  readonly portable: boolean | null;
  /** Internal locator only. Never include this field in an export or diagnostic error. */
  readonly executablePath: string | null;
}

// No launch, injection, setting changes, titles, usernames or full command lines.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MizarObsReadToken {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int length);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int[] Read(uint pid) {
  IntPtr process=OpenProcess(0x1000,false,pid), token=IntPtr.Zero;
  if(process==IntPtr.Zero) return new int[]{-1,Marshal.GetLastWin32Error()};
  try {
   if(!OpenProcessToken(process,8,out token)) return new int[]{-1,Marshal.GetLastWin32Error()};
   int value,length;
   if(!GetTokenInformation(token,20,out value,4,out length)) return new int[]{-1,Marshal.GetLastWin32Error()};
   return new int[]{value,0};
  } finally { if(token!=IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
 }
}
'@
$records = @(Get-CimInstance Win32_Process -Filter "Name='obs64.exe' OR Name='obs32.exe' OR Name='cs2.exe'" | Select-Object -First 8 | ForEach-Object {
 $role=if($_.Name -eq 'cs2.exe'){'cs2'}else{'obs'}
 $flags=$_.CommandLine
 $token=[MizarObsReadToken]::Read([uint32]$_.ProcessId)
 [pscustomobject]@{
  role=$role; pid=[int]$_.ProcessId; executablePath=$_.ExecutablePath;
  startedAt=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null};
  elevated=if($token[0] -lt 0){$null}else{$token[0] -ne 0}; elevationError=if($token[1]){$token[1]}else{$null};
  allowThirdParty=if($role -eq 'cs2' -and $flags){[bool]($flags -match '(?i)(?:^|\s)-allow_third_party_software(?:\s|$)')}else{$null};
  portable=if($role -eq 'obs' -and $flags){[bool]($flags -match '(?i)(?:^|\s)(?:--portable|-p)(?:\s|$)')}else{$null}
 }
})
ConvertTo-Json -Compress -Depth 4 -InputObject @($records)
`;

const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);

export async function readObsNativeProcesses(): Promise<readonly ObsNativeProcess[]> {
  if (process.platform !== 'win32') throw new Error('obs_native_platform_unsupported');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { timeout: 3000, maxBuffer: 32 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, output, stderr) => {
        if (error instanceof Error)
          reject(
            Object.assign(new Error(stderr.trim().split('\n')[0] || error.message.split('\n')[0]), {
              code: error.killed ? 'ETIMEDOUT' : error.code,
            }),
          );
        else if (error) reject(new Error('obs_native_process_query_failed'));
        else resolve(output);
      },
    );
  });
  return parseObsNativeProcesses(stdout);
}

export function parseObsNativeProcesses(stdout: string): readonly ObsNativeProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    // JSON parser messages can contain raw stdout. Do not retain the parser exception.
    throw new Error('obs_native_process_response_invalid');
  }
  if (!Array.isArray(parsed)) throw new Error('obs_native_process_response_invalid');
  return parsed.slice(0, 8).flatMap((item: unknown): ObsNativeProcess[] => {
    if (!item || typeof item !== 'object') throw new Error('obs_native_process_response_invalid');
    const p = item as Record<string, unknown>;
    if (
      !['obs', 'cs2'].includes(String(p.role)) ||
      typeof p.pid !== 'number' ||
      !Number.isSafeInteger(p.pid) ||
      p.pid <= 0
    )
      throw new Error('obs_native_process_response_invalid');
    return [
      {
        role: p.role as 'obs' | 'cs2',
        pid: p.pid,
        startedAt:
          typeof p.startedAt === 'string' && Number.isFinite(Date.parse(p.startedAt))
            ? new Date(p.startedAt).toISOString()
            : null,
        elevated: bool(p.elevated),
        elevationError:
          typeof p.elevationError === 'number' && Number.isSafeInteger(p.elevationError)
            ? p.elevationError
            : null,
        allowThirdParty: bool(p.allowThirdParty),
        portable: bool(p.portable),
        executablePath:
          typeof p.executablePath === 'string' && p.executablePath.length <= 4096
            ? p.executablePath
            : null,
      },
    ];
  });
}
