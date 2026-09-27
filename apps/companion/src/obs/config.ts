import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

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
  constructor(private readonly filePath: string) {}
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
    } finally {
      await rm(temp, { force: true });
    }
  }
}

export async function discoverObsExecutable(savedPath: string | null): Promise<string | null> {
  if (savedPath !== null && basename(savedPath).toLowerCase() === 'obs64.exe') {
    try {
      await access(savedPath);
      return savedPath;
    } catch {
      /* discover the running process */
    }
  }
  const running =
    process.platform === 'win32'
      ? await new Promise<string | null>((resolve) => {
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Get-CimInstance Win32_Process -Filter "Name = \'obs64.exe\'" | Select-Object -First 1 -ExpandProperty ExecutablePath',
            ],
            { timeout: 2000, windowsHide: true },
            (error, stdout) => resolve(error ? null : stdout.trim().split(/\r?\n/)[0] || null),
          );
        })
      : null;
  const candidates = [
    running,
    ...(process.platform === 'win32'
      ? [
          join(
            process.env.ProgramFiles ?? 'C:\\Program Files',
            'obs-studio',
            'bin',
            '64bit',
            'obs64.exe',
          ),
          join(
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
            'obs-studio',
            'bin',
            '64bit',
            'obs64.exe',
          ),
        ]
      : []),
  ];
  for (const path of candidates) {
    if (path === null || basename(path).toLowerCase() !== 'obs64.exe') continue;
    try {
      await access(path);
      return path;
    } catch {
      /* try the next installed path */
    }
  }
  return null;
}
