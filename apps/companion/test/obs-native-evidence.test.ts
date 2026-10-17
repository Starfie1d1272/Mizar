import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as nativeEvidence from '../src/obs/native-evidence.js';
import { buildApp } from '../src/app.js';
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
  vi.restoreAllMocks();
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

it('exports full related OBS text through the real route and decoder, retaining CEF/performance context and excluding credentials and unrelated sessions', async () => {
  const { appData, root } = await fixture();
  const date = new Date(Date.now() - 2000);
  const filename = (value: Date) =>
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')} ${String(value.getHours()).padStart(2, '0')}-${String(value.getMinutes()).padStart(2, '0')}-${String(value.getSeconds()).padStart(2, '0')}.txt`;
  const localClock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.000`;
  await writeFile(join(root, 'user.ini'), '[Basic]\nProfileDir=private-profile\n');
  const streamKey = 'CANARY-OBS-STREAM-KEY';
  const password = 'CANARY websocket password with spaces';
  await writeFile(
    join(root, 'basic', 'profiles', 'private-profile', 'service.json'),
    JSON.stringify({
      settings: { key: streamKey },
      privateUnusedField: 'CONFIG-BODY-NOT-COLLECTED',
    }),
  );
  await mkdir(join(root, 'plugin_config', 'obs-websocket'), { recursive: true });
  await writeFile(
    join(root, 'plugin_config', 'obs-websocket', 'config.json'),
    JSON.stringify({ server_password: password }),
  );
  const source = [
    `${localClock}: [game-capture: 'Mizar · CS2 Game Capture'] attempting to hook process: cs2.exe`,
    `${localClock}: [obs-browser] CEF ERR_FAILED technical-path=C:\\Mizar\\hud map=de_nuke`,
    `${localClock}: long CEF detail ${'x'.repeat(12000)} final-CEF-detail`,
    `${localClock}: credential test bare ${streamKey} and ${password}`,
    `${localClock}: stream key: "ANOTHER-STREAM-CANARY" context-remains`,
    ...Array.from(
      { length: 3000 },
      (_, index) => `${localClock}: render performance observation ${index} ${'z'.repeat(900)}`,
    ),
    `${localClock}: Total frames output: 48381; lagged frames: 17; skipped frames: 9`,
    '',
  ].join('\n');
  await writeFile(join(root, 'logs', filename(date)), source);
  await writeFile(
    join(root, 'logs', filename(new Date(date.getTime() - 1000))),
    `${localClock}: UNRELATED-OBS-SESSION-NOT-COLLECTED\n`,
  );
  const options = {
    platform: 'win32' as const,
    appData,
    readProcesses: () => Promise.resolve([]),
    includeRelatedLogs: true,
  };
  const result = await collectObsNativeEvidence(options);
  const full = result.relatedLogFiles!.find((file) => file.status === 'read')!;
  expect(full.sourceBytes).toBeGreaterThan(2651122);
  expect(full.readBytes).toBe(Buffer.byteLength(source));
  const retained = Buffer.concat(
    full.volumes.map((volume) => {
      const bytes = gunzipSync(Buffer.from(volume.gzipBase64, 'base64'));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(volume.sha256);
      return bytes;
    }),
  );
  expect(createHash('sha256').update(retained).digest('hex')).toBe(full.sha256);
  expect(retained.toString()).toContain('CEF ERR_FAILED technical-path=');
  expect(retained.toString()).toContain('final-CEF-detail');
  expect(retained.toString()).toContain(
    'Total frames output: 48381; lagged frames: 17; skipped frames: 9',
  );
  expect(retained.toString()).toContain('context-remains');
  for (const credential of [streamKey, password, 'ANOTHER-STREAM-CANARY'])
    expect(retained.toString()).not.toContain(credential);
  expect(result.relatedLogFiles).toContainEqual(
    expect.objectContaining({ status: 'mizar_association_not_established', volumes: [] }),
  );
  vi.spyOn(nativeEvidence, 'collectObsNativeEvidence').mockResolvedValueOnce(result);
  const app = buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/debug/support-bundle',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json<{ fullLogs: { files: typeof result.relatedLogFiles } }>();
    expect(bundle.fullLogs.files).toContainEqual(full);
    expect(response.body).not.toContain('CONFIG-BODY-NOT-COLLECTED');
    expect(response.body).not.toContain('UNRELATED-OBS-SESSION-NOT-COLLECTED');
    const path = join(appData, 'synthetic-export.json');
    await writeFile(path, response.body);
    const decoded = await promisify(execFile)(
      process.execPath,
      ['scripts/diagnostics/read-support-bundle.mjs', path],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    expect(decoded.stdout).toContain('final-CEF-detail');
    expect(decoded.stdout).toContain('lagged frames: 17; skipped frames: 9');
    expect(decoded.stdout).toContain('obs_log_line');
    const timeline = decoded.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text?: string; time?: string });
    expect(timeline.find((event) => event.text?.includes('Mizar · CS2 Game Capture'))?.time).toBe(
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
      ).toISOString(),
    );

    expect(decoded.stdout).not.toContain(streamKey);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      schema: 'mizar-support-bundle/1',
    });
  } finally {
    await app.close();
  }
  await writeFile(join(root, 'basic', 'profiles', 'private-profile', 'service.json'), '{broken');
  const unsafe = await collectObsNativeEvidence(options);
  expect(unsafe.relatedLogFiles).toContainEqual(
    expect.objectContaining({ status: 'credential_context_unreadable', volumes: [] }),
  );
}, 15000);
