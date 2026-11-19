import { execFile } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { safePath } from '../resource-store/files.js';
import type { ObsConfig } from './config.js';

// Read only the process identity, flags that affect configuration, and listener ports.
const query = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$all = @(Get-CimInstance Win32_Process -Filter "Name='obs64.exe' OR Name='obs32.exe'" | Select-Object -First 2)
if ($all.Count -ne 1) { 'null'; exit }
$process = $all[0]
$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or !$process.CommandLine -or !$process.CreationDate -or $process.CommandLine -match '(?i)(?:^|\s)"?--websocket_') { 'null'; exit }
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in '127.0.0.1', '0.0.0.0', '::' })
$ports = @($listeners | Group-Object LocalPort | Where-Object {
  @($_.Group | Where-Object { $_.OwningProcess -ne $process.ProcessId }).Count -eq 0
} | Select-Object -First 16 | ForEach-Object { [int]$_.Name })
[pscustomobject]@{
  pid = $process.ProcessId; started = $process.CreationDate.ToUniversalTime().ToString('o');
  executable = $process.ExecutablePath; ports = $ports;
  portable = [bool]($process.CommandLine -match '(?i)(?:^|\s)"?(?:--portable|-p)"?(?:\s|$)')
} | ConvertTo-Json -Compress
`;

async function runningObs() {
  if (process.platform !== 'win32') throw new Error('local_obs_unavailable');
  const result = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { timeout: 4000, windowsHide: true, maxBuffer: 8192, encoding: 'utf8' },
      (error, stdout) => (error ? reject(new Error('local_obs_unavailable')) : resolve(stdout)),
    );
  });
  const obs = JSON.parse(result.replace(/^\uFEFF/, '')) as {
    pid: number;
    started: string;
    executable: string | null;
    ports: number[];
    portable: boolean;
  } | null;
  if (!obs?.executable || !/^[a-z]:[\\/]/i.test(obs.executable))
    throw new Error('local_obs_unavailable');
  const executablePath = await realpath(obs.executable);
  if (basename(executablePath).toLowerCase() !== 'obs64.exe')
    throw new Error('local_obs_unavailable');
  return { ...obs, executablePath };
}

export function parseLocalWebSocketSettings(raw: unknown): Pick<ObsConfig, 'port' | 'password'> {
  if (!raw || typeof raw !== 'object') throw new Error('local_obs_settings_unavailable');
  const settings = raw as Record<string, unknown>;
  if (settings.server_enabled === false) throw new Error('local_obs_websocket_disabled');
  const port = settings.server_port;
  if (
    settings.server_enabled !== true ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof settings.auth_required !== 'boolean'
  )
    throw new Error('local_obs_settings_unavailable');
  const password = settings.auth_required ? settings.server_password : '';
  if (
    typeof password !== 'string' ||
    password.length > 1024 ||
    (settings.auth_required && !password)
  )
    throw new Error('local_obs_settings_unavailable');
  return { port, password };
}

export async function readLocalObsConnection(selected: string | null) {
  const obs = await runningObs();
  if (selected && (await realpath(selected)).toLowerCase() !== obs.executablePath.toLowerCase())
    throw new Error('local_obs_unavailable');
  const installRoot = dirname(dirname(dirname(obs.executablePath)));
  const portableMarker = await Promise.all(
    ['portable_mode', 'obs_portable_mode', 'portable_mode.txt', 'obs_portable_mode.txt'].map(
      (name) =>
        safePath(installRoot, name).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ),
    ),
  );
  const appData = process.env.APPDATA;
  if (!obs.portable && !portableMarker.some(Boolean) && (!appData || !isAbsolute(appData)))
    throw new Error('local_obs_settings_unavailable');
  const root =
    obs.portable || portableMarker.some(Boolean)
      ? join(installRoot, 'config', 'obs-studio')
      : join(appData!, 'obs-studio');
  const file = await open(await safePath(root, 'plugin_config/obs-websocket/config.json'), 'r');
  let settings: Pick<ObsConfig, 'port' | 'password'>;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64 * 1024)
      throw new Error('local_obs_settings_unavailable');
    const data = Buffer.alloc(metadata.size);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== data.length) throw new Error('local_obs_settings_unavailable');
    settings = parseLocalWebSocketSettings(
      JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')),
    );
  } finally {
    await file.close();
  }
  if (!obs.ports.includes(settings.port)) throw new Error('local_obs_listener_unavailable');
  return {
    config: { ...settings, executablePath: obs.executablePath, host: '127.0.0.1' },
    stillCurrent: async () => {
      const current = await runningObs();
      return (
        current.pid === obs.pid &&
        current.started === obs.started &&
        current.executablePath === obs.executablePath &&
        current.ports.includes(settings.port)
      );
    },
  };
}
