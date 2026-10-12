import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, rename, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectObsNativeEvidence, redactObsNativeText } from '../src/obs/native-evidence.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(open).mockClear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const appData = await mkdtemp(join(await realpath(tmpdir()), 'mizar-native-'));
  dirs.push(appData);
  const root = join(appData, 'obs-studio');
  await mkdir(join(root, 'logs'), { recursive: true });
  await mkdir(join(root, 'basic', 'profiles', 'private-profile'), { recursive: true });
  await mkdir(join(root, 'basic', 'scenes'), { recursive: true });
  return { appData, root };
}

describe('OBS native evidence', () => {
  it('rejects an APPDATA ancestor directory junction, including on Windows without symlink privilege', async () => {
    const actual = await fixture();
    const parent = await fixture();
    const link = join(parent.appData, 'linked-appdata');
    await symlink(actual.appData, link, 'junction');
    await writeFile(join(actual.root, 'user.ini'), '[Basic]\nProfileDir=private-profile');
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData: link,
      readProcesses: () => Promise.resolve([]),
    });
    expect(result.roots[0]?.fileStatus.user).toBe('failed');
    expect(result.roots[0]?.logsStatus).toBe('failed');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'EUNSAFE' }));
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });
  it('rejects a file replaced between lstat and open before reading it', async () => {
    const { appData, root } = await fixture();
    await writeFile(join(root, 'user.ini'), '[Basic]\n');
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await rename(String(path), String(path) + '.original');
      await writeFile(String(path), 'private-secret');
      return actual.open(path, flags, mode);
    });
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      readProcesses: () => Promise.resolve([]),
    });
    expect(result.roots[0]?.fileStatus.user).toBe('failed');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'ECHANGED' }));
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('redacts Unicode executable names, spaced process targets and streaming-key aliases', () => {
    for (const text of [
      'hook_direct: could not open process: 私人项目.exe (5)',
      'could not open process: 私人 项目.exe (5)',
      'cannot capture 私人 项目.exe due to being blacklisted',
      'failed to open 私人项目.exe',
    ]) {
      expect(redactObsNativeText(text)).not.toMatch(/私人|项目/);
    }
    for (const alias of ['streamKey', 'stream_key', 'stream-key']) {
      const text = 'hook_direct: inject failed: 5 ' + alias + '=synthetic-fixture-value';
      expect(redactObsNativeText(text)).not.toContain('synthetic-fixture-value');
    }
  });
});
