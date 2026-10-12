import upstreamCaptureExamples from './fixtures/obs-native/game-capture.json' with { type: 'json' };
import upstreamRendererExamples from './fixtures/obs-native/d3d11.json' with { type: 'json' };
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  utimes,
  symlink,
  realpath,
  rename,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectObsNativeEvidence,
  boundObsNativeEvidence,
  redactObsNativeText,
  type ObsNativeEvidence,
  OBS_NATIVE_LIMITS,
  projectObsNativeLogLine,
  projectObsSavedCollection,
} from '../src/obs/native-evidence.js';
import {
  projectObsCaptureDiagnostic,
  createObsCaptureDiagnosticReader,
} from '../src/obs/capture-diagnostic.js';
import { parseObsNativeProcesses } from '../src/obs/native-process.js';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from '../src/obs/desired-state.js';

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
  it('retains early failures through thousands of unrelated polls and exports all related technical events', async () => {
    const { appData, root } = await fixture();
    const now = Date.parse('2026-10-11T12:30:00Z');
    const file = join(root, 'logs', '2026-10-11 12-00-00.txt');
    const failure = `12:10:00.000: [game-capture: '${OBS_CAPTURE_INPUT}'] could not open process: cs2.exe\n`;
    await writeFile(
      file,
      failure.repeat(52) + '12:20:00.000: private polling body token=secret-value\n'.repeat(10000),
    );
    await utimes(file, new Date(now), new Date(now));
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      now: () => now,
      readProcesses: () => Promise.resolve([]),
      includeRelatedLogs: true,
    });
    const log = result.roots[0]!.logs[0]!;
    expect(log.events).toContainEqual(
      expect.objectContaining({ reason: 'process_open_failed', code: null }),
    );
    expect(Object.values(log.failureCounts!)).toEqual([52]);
    expect(log.scan).toMatchObject({
      missingByteRange: null,
      ignoredLines: 10000,
      omittedEvents: 28,
    });
    expect(result.logAttachments![0]!.events).toHaveLength(52);
    expect(result.logAttachments![0]!.omittedEvents).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private polling|secret-value|token=/);
  });
  it('classifies access errors, unknown process-open errors, hook file sharing violations and pending hooks independently', () => {
    const line = (text: string) =>
      projectObsNativeLogLine(`12:29:59.000: [game-capture: '${OBS_CAPTURE_INPUT}'] ${text}`)!;
    expect(line('could not open process: cs2.exe')).toMatchObject({
      reason: 'process_open_failed',
      code: null,
    });
    expect(line('could not open process: cs2.exe (5)')).toMatchObject({
      reason: 'process_open_failed',
      code: 5,
    });
    expect(
      projectObsNativeLogLine(
        '12:29:59.000: update_hook_file: failed to update C:\\ProgramData\\obs-studio-hook\\graphics-hook64.dll (32)',
      ),
    ).toMatchObject({ reason: 'hook_file_locked', code: 32, category: 'hook' });
    expect(line('hook not loaded yet, retrying..')).toMatchObject({
      outcome: 'retry',
      reason: null,
      code: null,
    });
    expect(
      projectObsNativeLogLine('12:29:59.000: d3d11 shared texture capture successful'),
    ).toMatchObject({ outcome: 'success', category: 'hook' });
    for (const [text, operation, reason] of [
      [
        'cannot capture private.exe due to being blacklisted',
        'capture_target_policy',
        'target_blacklisted',
      ],
      ['Failed to create keepalive mutex: 5', 'keepalive_mutex_create', 'mutex_create_failed'],
      [
        "Game capture file 'private.dll' could not be loaded: 5.",
        'hook_file_load',
        'hook_file_load_failed',
      ],
      [
        'error acquiring, failed to get window thread/process ids: 5',
        'window_thread_process_ids',
        'window_process_query_failed',
      ],
      [
        'init_events: failed to get hook_ready event: 5',
        'hook_ready_event_open',
        'hook_event_open_failed',
      ],
      [
        'init_events: failed to get hook_stop event: 5',
        'hook_stop_event_open',
        'hook_event_open_failed',
      ],
    ] as const)
      expect(line(text)).toMatchObject({ operation, reason });
  });
  it('clears current alarms after capture succeeds, retains history, and shares repeated read-only checks', async () => {
    const { appData, root } = await fixture();
    const now = Date.parse('2026-10-11T12:30:00Z');
    const file = join(root, 'logs', '2026-10-11 12-00-00.txt');
    const processes = parseObsNativeProcesses(
      JSON.stringify([{ role: 'obs', pid: 42, startedAt: '2026-10-11T12:00:00Z' }]),
    );
    const collect = () =>
      collectObsNativeEvidence({
        platform: 'win32',
        appData,
        now: () => now,
        readProcesses: () => Promise.resolve(processes),
      });
    const failure = `12:29:58.000: [game-capture: '${OBS_CAPTURE_INPUT}'] could not open process: cs2.exe (5)\n`;
    await writeFile(file, failure);
    await utimes(file, new Date(now), new Date(now));
    expect(projectObsCaptureDiagnostic(await collect(), now)).toMatchObject({
      state: 'needs_attention',
      reason: 'access_denied',
    });
    await writeFile(
      file,
      failure +
        `12:29:59.000: [game-capture: '${OBS_CAPTURE_INPUT}'] shared texture capture successful\n`,
    );
    await utimes(file, new Date(now), new Date(now));
    const recovered = await collect();
    expect(recovered.roots[0]!.logs[0]!.events.some((e) => e.outcome === 'failure')).toBe(true);
    expect(projectObsCaptureDiagnostic(recovered, now)).toMatchObject({
      state: 'reported_success',
      reason: null,
      lastFailure: null,
    });
    await writeFile(
      file,
      failure +
        '12:29:58.100: update_hook_file: failed to update C:\\ProgramData\\obs-studio-hook\\graphics-hook64.dll (32)\n' +
        `12:29:58.500: [game-capture: '${OBS_CAPTURE_INPUT}'] shared texture capture successful\n` +
        `12:29:59.000: [game-capture: '${OBS_CAPTURE_INPUT}'] hook not loaded yet, retrying..\n`,
    );
    await utimes(file, new Date(now), new Date(now));
    const pendingAgain = await collect();
    expect(projectObsCaptureDiagnostic(pendingAgain, now)).toMatchObject({
      state: 'needs_attention',
      reason: 'hook_pending',
      lastFailure: null,
    });
    expect(
      pendingAgain.roots[0]!.logs[0]!.events.some((event) => event.reason === 'hook_file_locked'),
    ).toBe(true);
    expect(
      projectObsCaptureDiagnostic({ ...recovered, collectionStatus: 'timeout' }, now),
    ).toMatchObject({ state: 'unknown' });
    recovered.roots[0]!.logs[0]!.processAssociation = 'unverified';
    expect(projectObsCaptureDiagnostic(recovered, now)).toMatchObject({ state: 'unknown' });
    const read = vi.fn(() => Promise.resolve(recovered));
    const reader = createObsCaptureDiagnosticReader(read, () => now);
    await Promise.all([reader(), reader(), reader()]);
    expect(read).toHaveBeenCalledTimes(1);
    await reader();
    expect(read).toHaveBeenCalledTimes(1);
    await reader(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('dates overnight events from the session and log order instead of assigning old failures the file modification date', async () => {
    const { appData, root } = await fixture();
    const start = new Date(2026, 9, 11, 0, 0, 0);
    const now = new Date(2026, 9, 12, 0, 0, 20).getTime();
    const file = join(root, 'logs', '2026-10-11 00-00-00.txt');
    const history = `00:00:05.000: [game-capture: '${OBS_CAPTURE_INPUT}'] could not open process: cs2.exe (5)\n23:59:59.000: normal polling\n00:00:15.000: normal polling\n`;
    const collect = () =>
      collectObsNativeEvidence({
        platform: 'win32',
        appData,
        now: () => now,
        readProcesses: () =>
          Promise.resolve(
            parseObsNativeProcesses(
              JSON.stringify([{ role: 'obs', pid: 42, startedAt: start.toISOString() }]),
            ),
          ),
      });
    await writeFile(file, history);
    await utimes(file, new Date(now), new Date(now));
    const old = await collect();
    expect(old.roots[0]!.logs[0]!.latestCaptureEvent?.occurredAt).toBe(
      new Date(2026, 9, 11, 0, 0, 5).toISOString(),
    );
    expect(projectObsCaptureDiagnostic(old, now).state).toBe('unknown');
    await writeFile(
      file,
      history +
        `00:00:19.000: [game-capture: '${OBS_CAPTURE_INPUT}'] could not open process: cs2.exe (5)\n`,
    );
    await utimes(file, new Date(now), new Date(now));
    expect(projectObsCaptureDiagnostic(await collect(), now)).toMatchObject({
      state: 'needs_attention',
      reason: 'access_denied',
    });
    await writeFile(
      file,
      `03:00:00.000: normal polling\n02:00:00.000: [game-capture: '${OBS_CAPTURE_INPUT}'] could not open process: cs2.exe (5)\n`,
    );
    await utimes(file, new Date(now), new Date(now));
    expect(projectObsCaptureDiagnostic(await collect(), now).state).toBe('unknown');
  });
  it('reports bounded scan and attachment omissions separately without retaining arbitrary failure bodies', async () => {
    const { appData, root } = await fixture();
    const now = Date.parse('2026-10-11T12:30:00Z');
    const file = join(root, 'logs', '2026-10-11 12-00-00.txt');
    const line = `12:29:59.000: [game-capture: '${OBS_CAPTURE_INPUT}'] init_capture_data: failed to open file mapping: 5 private-body token=secret\n`;
    await writeFile(file, line.repeat(2000) + 'x'.repeat(OBS_NATIVE_LIMITS.logScanBytes));
    await utimes(file, new Date(now), new Date(now));
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      now: () => now,
      includeRelatedLogs: true,
      readProcesses: () => Promise.resolve([]),
    });
    const log = result.roots[0]!.logs[0]!;
    expect(log.scan).toMatchObject({
      readBytes: OBS_NATIVE_LIMITS.logScanBytes,
      missingByteRange: [
        OBS_NATIVE_LIMITS.logScanBytes,
        Buffer.byteLength(line.repeat(2000)) + OBS_NATIVE_LIMITS.logScanBytes,
      ],
    });
    const attachment = result.logAttachments![0]!;
    expect(attachment.events.length + attachment.omittedEvents).toBe(2000);
    expect(attachment.omittedEvents).toBeGreaterThan(0);
    expect(attachment).toMatchObject({
      firstOmittedLocalTime: '12:29:59.000',
      lastOmittedLocalTime: '12:29:59.000',
    });
    expect(JSON.stringify(result)).not.toMatch(/private-body|secret|token=/);
  });
  it('merges OBS BasicWindow collection selection with Basic profile settings', async () => {
    const { appData, root } = await fixture();
    await writeFile(
      join(root, 'user.ini'),
      '[BasicWindow]\nSceneCollectionFile=private-collection.json\n[Basic]\nProfileDir=private-profile',
    );
    await writeFile(
      join(root, 'basic', 'scenes', 'private-collection.json'),
      JSON.stringify(saved()),
    );
    const result = await collectObsNativeEvidence({
      platform: 'win32',
      appData,
      readProcesses: () => Promise.resolve([]),
    });
    expect(result.roots[0]!.fileStatus.collection).toBe('read');
    expect(result.roots[0]!.config).toMatchObject({ collectionRead: true });
  });
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
  it('keeps upstream capture initialization and blocked-target errors without claiming current frame failure', () => {
    for (const text of [
      'init_events: failed to get hook_ready event: 5',
      'init_capture_data: failed to open file mapping: 5',
      'error acquiring, failed to get window information: 5',
      'cannot capture private.exe due to being blacklisted',
    ]) {
      const event = projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] " + text,
      );
      expect(event?.outcome).toBe('failure');
      expect(JSON.stringify(event)).not.toContain('private');
    }
    expect(
      projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] hook not loaded yet, retrying..",
      ),
    ).toMatchObject({ outcome: 'retry' });
  });
  it('retains every failure logger branch from audited OBS game-capture sources', () => {
    for (const sample of upstreamCaptureExamples) {
      const event = projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] " + sample.text,
      );
      expect(event, sample.text).toMatchObject({
        category: sample.category,
        outcome: sample.outcome,
      });
      expect(event?.operation, sample.text).toBeTruthy();
      expect(event?.message, sample.text).not.toMatch(/^capture failure/);
      expect(JSON.stringify(event)).not.toContain('private');
    }
    expect(
      projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] init_hook_info: user is forcing shared memory (multi-adapter compatibility mode)",
      ),
    ).toBeNull();
  });
  it('retains all audited D3D11 backend error logger formats without depending on English failure keywords', () => {
    for (const sample of upstreamRendererExamples) {
      const event = projectObsNativeLogLine('12:00:00.000: ' + sample.text);
      expect(event, sample.text).toMatchObject({
        category: 'renderer',
        outcome: 'failure',
        reason: 'renderer_failure',
      });
      if (sample.codeHex) expect(event).toMatchObject({ codeHex: sample.codeHex });
      expect(JSON.stringify(event)).not.toMatch(/private|Alice/);
    }
    expect(
      projectObsNativeLogLine(
        '12:00:00.000: Hardware-Accelerated GPU Scheduling enabled on adapter!',
      ),
    ).toBeNull();
  });
  it('projects helper exit codes, incompatible hook versions and HRESULTs in their actual numeric bases', () => {
    expect(
      projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] inject process failed: -1073741819",
      ),
    ).toMatchObject({ reason: 'inject_helper_failed', code: -1073741819, codeHex: null });
    expect(
      projectObsNativeLogLine(
        "12:00:00.000: [game-capture: 'private-source'] cannot initialize hook, DLL hook version is 3.1, current plugin hook major version is 2.5",
      ),
    ).toMatchObject({
      reason: 'hook_version_incompatible',
      code: null,
      hookVersions: { dll: '3.1', plugin: '2.5' },
    });
    expect(
      projectObsNativeLogLine(
        '12:00:00.000: device_texture_create (D3D11): Failed to create 2D texture (8007000E)',
      ),
    ).toMatchObject({
      category: 'renderer',
      reason: 'renderer_failure',
      code: 2147942414,
      codeHex: '0x8007000E',
    });
    expect(
      projectObsNativeLogLine('12:00:00.000:   Device Removed Reason: 887A0005'),
    ).toMatchObject({ category: 'renderer', code: 2289696773, codeHex: '0x887A0005' });
    const event = projectObsNativeLogLine(
      '12:00:00.000: device_texture_create (D3D11): Failed C:\\Users\\Alice\\private.png (8007000E)',
    );
    expect(event).toMatchObject({ codeHex: '0x8007000E' });
    expect(JSON.stringify(event)).not.toMatch(/Alice|private.png/);
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
    // Detailed technical operations remain bounded by the final summary byte budget.
    expect(result.exportTruncated).toBe(true);
    expect(result.roots[0]!.logs[0]!.scan!.reasons).toContain('summary_event_limit');
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
  it.each(['portable_mode', 'obs_portable_mode', 'portable_mode.txt', 'obs_portable_mode.txt'])(
    'recognizes the official portable marker %s',
    async (marker) => {
      const { appData } = await fixture();
      const installation = join(appData, 'private-installation');
      await mkdir(join(installation, 'config', 'obs-studio'), { recursive: true });
      await writeFile(join(installation, marker), '');
      const processes = parseObsNativeProcesses(
        JSON.stringify([
          {
            role: 'obs',
            pid: 42,
            portable: false,
            executablePath: join(installation, 'bin', '64bit', 'obs64.exe'),
          },
        ]),
      );
      const result = await collectObsNativeEvidence({
        platform: 'win32',
        appData,
        readProcesses: () => Promise.resolve(processes),
      });
      expect(result.roots.map((r) => r.location)).toContain('portable_process');
      expect(JSON.stringify(result)).not.toContain(installation);
    },
  );
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
  it('falls back explicitly when protected evidence still exceeds the final UTF-8 JSON byte budget', () => {
    const event = {
      localTime: '12:00:00.000',
      category: 'hook' as const,
      outcome: 'failure' as const,
      source: null,
      target: null,
      message: '\u0000'.repeat(320),
      reason: 'capture_failure' as const,
      code: 5,
      codeHex: null,
      hookVersions: null,
    };
    const collection = projectObsSavedCollection(saved());
    const evidence: ObsNativeEvidence = {
      collectionStatus: 'available',
      processStatus: 'available',
      processes: [],
      errors: [],
      limits: OBS_NATIVE_LIMITS,
      exportTruncated: false,
      interpretation: 'read_only_evidence_not_black_screen_root_cause',
      roots: Array.from({ length: 2 }, () => ({
        location: 'appdata_candidate',
        fileStatus: {},
        directoryTruncated: false,
        logsStatus: 'available',
        config: {
          collection: {
            ...collection,
            captureSources: Array.from({ length: 8 }, () => ({
              ...collection.captureSources[0],
              role: 'capture_1',
            })),
          },
        },
        logs: Array.from({ length: 2 }, () => ({
          slot: 0,
          modifiedAt: '2026-10-11T12:30:00Z',
          sessionStartedAt: '2026-10-11T12:00:00Z',
          processAssociation: 'unverified',
          processPid: null,
          obsVersion: '31.1.2',
          runningAsAdministrator: null,
          portable: null,
          renderer: null,
          truncated: false,
          omittedLines: 0,
          events: [{ ...event }, { ...event }],
        })),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(evidence, null, 2))).toBeGreaterThan(
      OBS_NATIVE_LIMITS.exportBytes,
    );
    const result = boundObsNativeEvidence(evidence);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(
      OBS_NATIVE_LIMITS.exportBytes,
    );
    expect(result).toMatchObject({
      collectionStatus: 'failed',
      exportTruncated: true,
      errors: [{ phase: 'export_budget' }],
    });
    expect(evidence.exportTruncated).toBe(false);
  });
  it('reports unreadable config and excludes symlink targets and stale logs', async () => {
    const { appData, root } = await fixture();
    await symlink(join(appData, 'outside'), join(root, 'user.ini'), 'junction');
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
