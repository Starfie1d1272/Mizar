import { mkdtemp, mkdir, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectObsNativeEvidence,
  OBS_NATIVE_LIMITS,
  projectObsNativeLogLine,
  projectObsSavedCollection,
} from '../src/obs/native-evidence.js';
import { parseObsNativeProcesses } from '../src/obs/native-process.js';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from '../src/obs/desired-state.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const appData = await mkdtemp(join(tmpdir(), 'mizar-native-'));
  dirs.push(appData);
  const root = join(appData, 'obs-studio');
  await mkdir(join(root, 'logs'), { recursive: true });
  await mkdir(join(root, 'basic', 'profiles', 'private-profile'), { recursive: true });
  await mkdir(join(root, 'basic', 'scenes'), { recursive: true });
  return { appData, root };
}
const saved = () => ({
  name: OBS_COLLECTION,
  current_program_scene: obsSceneName('gameplay'),
  current_scene: obsSceneName('waiting'),
  sources: [
    {
      id: 'scene',
      name: obsSceneName('gameplay'),
      settings: { items: [{ name: 'private-group', visible: false }] },
    },
    {
      id: 'game_capture',
      name: OBS_CAPTURE_INPUT,
      settings: {
        capture_mode: 'window',
        window: 'private-window-title:SDL_app:cs2.exe',
        anti_cheat_hook: true,
        capture_cursor: false,
        priority: 1,
      },
    },
    {
      id: 'browser_source',
      name: 'secret browser',
      settings: { url: 'https://private.example?token=private-token' },
    },
  ],
  groups: [
    {
      id: 'group',
      name: 'private-group',
      settings: { items: [{ name: OBS_CAPTURE_INPUT, visible: true }] },
    },
  ],
});

describe('OBS native evidence', () => {
  it('distinguishes saved Program from preview and resolves disabled groups without private names/settings', () => {
    const result = projectObsSavedCollection(saved());
    expect(result).toMatchObject({
      programScene: 'gameplay',
      previewScene: 'waiting',
      frameHealth: 'unverified',
      captureSources: [
        { role: 'mizar_capture', target: 'cs2.exe', enabled: false, antiCheatHook: true },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|https/);
    const onlyPreview = saved();
    delete (onlyPreview as Partial<typeof onlyPreview>).current_program_scene;
    expect(projectObsSavedCollection(onlyPreview)).toMatchObject({
      programScene: null,
      captureSources: [],
    });
  });
  it('retains technical hook error codes while excluding raw titles, paths, URLs and unrelated lines', () => {
    expect(
      projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] hook_direct: could not open process: private.exe (5)",
      ),
    ).toMatchObject({
      outcome: 'failure',
      message: 'hook_direct: could not open process: [executable] (5)',
    });
    expect(
      projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] attempting to hook process: cs2.exe",
      ),
    ).toMatchObject({ outcome: 'attempt', target: 'cs2.exe' });
    expect(projectObsNativeLogLine('12:00:00.000: private arbitrary line')).toBeNull();
    const event = projectObsNativeLogLine(
      "12:00:00.000: [game-capture: 'private-source'] Failed to create inject helper process: 5 C:\\Users\\Alice\\secret https://private.example/token",
    );
    expect(event?.message).toContain('5');
    expect(JSON.stringify(event)).not.toMatch(/Alice|secret|private.example/);
  });
  it('collects bounded native evidence and keeps absence/credentials out of conclusions', async () => {
    const { appData, root } = await fixture();
    const now = Date.parse('2026-10-11T12:30:00Z');
    await writeFile(
      join(root, 'user.ini'),
      '[Basic]\nProfileDir=private-profile\nSceneCollectionFile=private-collection\n[__proto__]\nx=private-secret',
    );
    await writeFile(
      join(root, 'basic', 'profiles', 'private-profile', 'basic.ini'),
      '[Video]\nBaseCX=1920\nBaseCY=1080\n[Stream1]\nKey=private-secret',
    );
    await writeFile(
      join(root, 'basic', 'scenes', 'private-collection.json'),
      JSON.stringify(saved()),
    );
    const file = join(root, 'logs', '2026-10-11 12-00-00.txt');
    await writeFile(
      file,
      "12:00:00.000: OBS 31.1.2 (64-bit, windows)\n12:00:00.000: Running as administrator: false\n12:00:00.000: Portable mode: false\n12:10:00.000: [game-capture: 'private-source'] hook_direct: inject failed: 5\n" +
        Array.from(
          { length: 40 },
          () => "12:20:00.000: [game-capture: 'private-source'] capture stopped\n",
        ).join(''),
    );
    await utimes(file, new Date(now), new Date(now));
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      now: () => now,
      readProcesses: () =>
        Promise.resolve(
          parseObsNativeProcesses(
            JSON.stringify([
              {
                role: 'obs',
                pid: 42,
                startedAt: '2026-10-11T12:00:00Z',
                elevated: false,
                executablePath: null,
              },
            ]),
          ),
        ),
    });
    expect(result).toMatchObject({
      collectionStatus: 'available',
      processStatus: 'available',
      roots: [
        {
          logsStatus: 'available',
          config: { profileRead: true, collection: { programScene: 'gameplay' } },
          logs: [
            {
              obsVersion: '31.1.2',
              processPid: 42,
              processAssociation: 'time_correlated',
              truncated: true,
            },
          ],
        },
      ],
    });
    expect(result.roots[0]?.logs[0]?.events.some((e) => e.outcome === 'failure')).toBe(true);
    expect(result.roots[0]?.logs[0]?.events).toHaveLength(24);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|executablePath/);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(
      OBS_NATIVE_LIMITS.exportBytes,
    );
  });
  it('reads a real header beyond a large log tail and enforces the projected byte budget', async () => {
    const { appData, root } = await fixture();
    const now = Date.parse('2026-10-11T12:30:00Z');
    const line =
      "12:20:00.000: [game-capture: 'private-source'] hook_direct: inject failed: 5 " +
      'x'.repeat(300) +
      '\n';
    for (const name of ['2026-10-11 12-00-00.txt', '2026-10-11 12-01-00.txt']) {
      const file = join(root, 'logs', name);
      await writeFile(file, '12:00:00.000: OBS 31.1.2 (64-bit, windows)\n' + line.repeat(300));
      await utimes(file, new Date(now), new Date(now));
    }
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      now: () => now,
      readProcesses: () => Promise.resolve([]),
    });
    expect(result.roots[0]?.logs).toHaveLength(2);
    expect(result.roots[0]?.logs.every((log) => log.obsVersion === '31.1.2' && log.truncated)).toBe(
      true,
    );
    expect(result.exportTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(
      OBS_NATIVE_LIMITS.exportBytes,
    );
  });
  it('locates portable evidence only through the OBS process and omits its private executable locator', async () => {
    const { appData, root } = await fixture();
    const installation = join(appData, 'private-installation');
    const portable = join(installation, 'config', 'obs-studio');
    await mkdir(portable, { recursive: true });
    await writeFile(join(portable, 'user.ini'), '[Basic]\n');
    const processes = parseObsNativeProcesses(
      JSON.stringify([
        {
          role: 'obs',
          pid: 44,
          executablePath: join(installation, 'bin', '64bit', 'obs64.exe'),
          portable: true,
        },
      ]),
    );
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      readProcesses: () => Promise.resolve(processes),
    });
    expect(result.roots.map((r) => r.location)).toEqual(['appdata_candidate', 'portable_process']);
    expect(result.roots[1]?.fileStatus.user).toBe('read');
    expect(result.roots[0]?.fileStatus.user).toBe('missing');
    expect(JSON.stringify(result)).not.toContain(installation);
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it('reports unreadable config and excludes symlink targets and stale logs', async () => {
    const { appData, root } = await fixture();
    await symlink(join(appData, 'outside'), join(root, 'user.ini'));
    const file = join(root, 'logs', '2020-01-01 12-00-00.txt');
    await writeFile(file, '12:00:00.000: D3D11 device removed error 5');
    await utimes(file, new Date(0), new Date(0));
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      readProcesses: () => Promise.resolve([]),
    });
    expect(result.roots[0]?.logs).toEqual([]);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'EUNSAFE' }));
    expect(result.roots[0]?.config?.userRead).toBe(false);
  });
  it('returns an immutable partial timeout instead of blocking the export on a hung process query', async () => {
    const { appData } = await fixture();
    let release!: (value: []) => void;
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      budgetMs: 10,
      readProcesses: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    expect(result.collectionStatus).toBe('timeout');
    release([]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(result.processStatus).toBe('unavailable');
    expect(result.roots).toEqual([]);
  });
  it('marks unsupported platforms and rejects malformed process output without echoing private stdout', async () => {
    expect((await collectObsNativeEvidence({ platform: 'linux' })).collectionStatus).toBe(
      'unsupported',
    );
    for (const value of ['private-secret', '{}', '[{"role":"private-secret","pid":1}]'])
      expect(() => parseObsNativeProcesses(value)).toThrow('obs_native_process_response_invalid');
  });
});
