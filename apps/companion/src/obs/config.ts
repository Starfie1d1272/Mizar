import { ManagedObsResources } from './managed-resources.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { ObsActionError } from './action-error.js';

/** A failed WebSocket connection does not prove the local OBS process is absent. */
export async function isObsProcessRunning(): Promise<boolean> {
  if (process.platform !== 'win32') throw new Error('OBS process detection requires Windows');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; @(Get-Process | Where-Object { $_.ProcessName -in @('obs64','obs32') }).Count",
      ],
      { timeout: 2000, windowsHide: true, maxBuffer: 4096, encoding: 'utf8' },
      (error, value) => {
        if (error instanceof Error) reject(error);
        else if (error) reject(new Error('OBS process query failed', { cause: error }));
        else resolve(value);
      },
    );
  });
  const count = stdout.trim();
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)))
    throw new Error('OBS process count response is invalid');
  return Number(count) > 0;
}

export interface ObsConfig {
  readonly executablePath: string | null;
  readonly host: string;
  readonly port: number;
  readonly password: string;
}

export const DEFAULT_OBS_CONFIG: ObsConfig = {
  executablePath: null,
  host: '127.0.0.1',
  port: 4455,
  password: '',
};

export function validateObsConfig(value: unknown): ObsConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('OBS 配置格式有误。');
  const config = value as Record<string, unknown>;
  if (
    config.host !== '127.0.0.1' ||
    !Number.isInteger(config.port) ||
    Number(config.port) < 1 ||
    Number(config.port) > 65535 ||
    typeof config.password !== 'string' ||
    config.password.length > 1024 ||
    (config.executablePath !== null &&
      (typeof config.executablePath !== 'string' ||
        basename(config.executablePath).toLowerCase() !== 'obs64.exe'))
  )
    throw new Error('OBS 配置格式有误。');
  return {
    executablePath: config.executablePath,
    host: '127.0.0.1',
    port: config.port as number,
    password: config.password,
  };
}

export class ObsConfigStore {
  private listeners = new Set<() => void>();
  onChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readonly managedResources: ManagedObsResources;
  constructor(private readonly filePath: string) {
    this.managedResources = new ManagedObsResources(`${filePath}.collection.json`);
  }
  async read(): Promise<ObsConfig> {
    try {
      return validateObsConfig(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown);
    } catch {
      return DEFAULT_OBS_CONFIG;
    }
  }
  async save(config: ObsConfig): Promise<void> {
    const value = validateObsConfig(config);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(temp, this.filePath);
      for (const listener of this.listeners) listener();
    } finally {
      await rm(temp, { force: true });
    }
  }
}

const windowsInstallations = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$uninstall = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$installed = @(Get-ItemProperty -Path $uninstall -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^OBS Studio(\s|$)' } |
  Select-Object -First 16 InstallLocation, DisplayIcon, UninstallString)
$running = @(Get-CimInstance Win32_Process -Filter "Name='obs64.exe'" -ErrorAction SilentlyContinue |
  Select-Object -First 8 -ExpandProperty ExecutablePath)
[pscustomobject]@{ installed = $installed; running = $running } | ConvertTo-Json -Compress -Depth 3
`;

type ObsRegistration = {
  InstallLocation?: unknown;
  DisplayIcon?: unknown;
  UninstallString?: unknown;
};

function registeredPaths(entry: ObsRegistration): string[] {
  const paths: string[] = [];
  for (const command of [entry.DisplayIcon, entry.UninstallString]) {
    if (typeof command !== 'string') continue;
    const executable = /^"([^"]+)"|^(.+?\.exe)(?=$|\s|,)/i.exec(command.trim());
    const path = executable?.[1] ?? executable?.[2];
    if (!path || !isAbsolute(path)) continue;
    if (basename(path).toLowerCase() === 'obs64.exe') paths.push(path);
    else paths.push(join(dirname(path), 'bin', '64bit', 'obs64.exe'));
  }
  if (typeof entry.InstallLocation === 'string') {
    const directory = entry.InstallLocation.trim().replace(/^"([^"]+)"$/, '$1');
    if (isAbsolute(directory))
      paths.push(join(directory, 'bin', '64bit', 'obs64.exe'), join(directory, 'obs64.exe'));
  }
  return paths;
}

async function existingExecutable(path: string | null): Promise<string | null> {
  if (!path || !isAbsolute(path) || basename(path).toLowerCase() !== 'obs64.exe') return null;
  try {
    const normalized = await realpath(path);
    if (basename(normalized).toLowerCase() === 'obs64.exe' && (await stat(normalized)).isFile())
      return normalized;
  } catch {
    // Try another registered or standard installation.
  }
  return null;
}

async function uniqueInstallation(paths: readonly string[]): Promise<string | null> {
  const locations = new Map<string, string>();
  for (const path of new Set(paths)) {
    if (!/^[a-z]:[\\/]/i.test(path)) continue;
    const found = await existingExecutable(path);
    if (found) locations.set(found.toLowerCase(), found);
  }
  if (locations.size > 1) throw new ObsActionError('executable_ambiguous');
  return locations.values().next().value ?? null;
}

export async function discoverObsExecutable(savedPath: string | null): Promise<string | null> {
  const saved = await existingExecutable(savedPath);
  if (saved || process.platform !== 'win32') return saved;
  const windows = await new Promise<{ running?: unknown; installed?: unknown }>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', windowsInstallations],
      { timeout: 2500, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        try {
          resolve(error ? {} : (JSON.parse(stdout) ?? {}));
        } catch {
          resolve({});
        }
      },
    );
  });
  const running = Array.isArray(windows.running)
    ? await uniqueInstallation(
        windows.running.filter((path): path is string => typeof path === 'string'),
      )
    : null;
  if (running) return running;
  const registered = Array.isArray(windows.installed)
    ? windows.installed.filter(
        (item): item is ObsRegistration => item !== null && typeof item === 'object',
      )
    : [];
  return uniqueInstallation([
    ...registered.flatMap(registeredPaths),
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((path): path is string => Boolean(path))
      .map((path) => join(path, 'obs-studio', 'bin', '64bit', 'obs64.exe')),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((path) => join(path.trim().replace(/^"([^"]+)"$/, '$1'), 'obs64.exe')),
  ]);
}
