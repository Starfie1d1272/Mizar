import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from './desired-state.js';
import { readObsNativeProcesses, type ObsNativeProcess } from './native-process.js';
import { redactDiagnosticText } from '../updates/diagnostics.js';

export const OBS_NATIVE_LIMITS = {
  collectionMs: 7000,
  roots: 2,
  directoryEntries: 128,
  logFiles: 2,
  logAgeMs: 24 * 60 * 60 * 1000,
  eventAgeMs: 2 * 60 * 60 * 1000,
  logHeaderBytes: 8192,
  logTailBytes: 65536,
  configBytes: 1024 * 1024,
  eventsPerLog: 24,
  captures: 8,
  exportBytes: 24 * 1024,
} as const;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.slice(0, 256).map(obj) : []);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
const number = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1000000 ? v : null;
const component = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 128 &&
  !/[\\/:]/.test(v) &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32) &&
  v !== '.' &&
  v !== '..';
const sceneId = (v: unknown) => PROGRAM_SCENES.find((s) => obsSceneName(s.id) === v)?.id ?? null;
const target = (v: unknown) =>
  typeof v !== 'string'
    ? null
    : v.split(':').at(-1)?.toLowerCase() === 'cs2.exe'
      ? 'cs2.exe'
      : 'other';

export function redactObsNativeText(text: string): string {
  return redactDiagnosticText(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\[(?:game|window|monitor)-capture:.*?\]\s*/gi, '[capture] ')
    .replace(/(['"])[^'"\r\n]*\1/g, '[quoted value]')
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n,;)]*/gi, '[path]')
    .replace(/\/(?:home|Users|tmp|var|etc)\/[^\s,;)]*/g, '[path]')
    .replace(/\b(?!cs2\.exe\b|obs(?:32|64)\.exe\b)[\w.-]+\.exe\b/gi, '[executable]')
    .slice(0, 320);
}
function failure(phase: string, error: unknown) {
  const e = obj(error);
  return {
    phase,
    code:
      typeof e.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code)
        ? e.code
        : typeof e.code === 'number' && Number.isSafeInteger(e.code)
          ? e.code
          : null,
    message: redactObsNativeText(
      error instanceof Error ? error.message.split('\n')[0]! : 'OBS evidence read failed',
    ),
  };
}
function ini(text: string): Record<string, Record<string, string>> {
  const result = Object.create(null) as Record<string, Record<string, string>>;
  let section = '';
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = /^\[([^\]]{1,80})\]$/.exec(line.trim());
    if (header) {
      section = header[1]!;
      continue;
    }
    const field = /^([^=;#]{1,80})=(.*)$/.exec(line);
    if (field)
      (result[section] ??= Object.create(null) as Record<string, string>)[field[1]!.trim()] =
        field[2]!.trim();
  }
  return result;
}
function configInt(v: string | undefined) {
  return v && /^\d{1,7}$/.test(v) ? number(Number(v)) : null;
}
export function projectObsSavedCollection(value: unknown) {
  const data = obj(value),
    sources = [...list(data.sources), ...list(data.groups)];
  const programName =
    typeof data.current_program_scene === 'string' ? data.current_program_scene : null;
  const sourceMap = new Map(
    sources.filter((s) => typeof s.name === 'string').map((s) => [String(s.name), s]),
  );
  const captures: Obj[] = [];
  let visited = 0;
  function walk(name: string | null, enabled: boolean | null, depth: number, seen: Set<string>) {
    if (!name || seen.has(name) || depth > 3 || visited++ >= 64) return;
    const source = sourceMap.get(name);
    if (!source) return;
    if (source.id === 'scene' || source.id === 'group') {
      const next = new Set(seen);
      next.add(name);
      for (const item of list(obj(source.settings).items).slice(0, 64))
        walk(
          typeof item.name === 'string' ? item.name : null,
          enabled === false || item.visible === false
            ? false
            : enabled === true && item.visible === true
              ? true
              : null,
          depth + 1,
          next,
        );
      return;
    }
    if (
      !['game_capture', 'window_capture', 'monitor_capture'].includes(String(source.id)) ||
      captures.length >= OBS_NATIVE_LIMITS.captures
    )
      return;
    const settings = obj(source.settings),
      parts = typeof settings.window === 'string' ? settings.window.split(':') : [];
    captures.push({
      role: name === OBS_CAPTURE_INPUT ? 'mizar_capture' : `capture_${captures.length + 1}`,
      kind: source.id,
      enabled,
      target: target(settings.window),
      windowClass:
        parts.length === 3
          ? ['SDL_app', 'Valve001'].includes(parts[1] ?? '')
            ? parts[1]
            : 'other'
          : null,
      mode: ['window', 'any_fullscreen', 'hotkey'].includes(String(settings.capture_mode))
        ? settings.capture_mode
        : null,
      priority: number(settings.priority),
      method: number(settings.method),
      antiCheatHook: bool(settings.anti_cheat_hook),
      compatibility: bool(settings.sli_compatibility),
      captureCursor: bool(settings.capture_cursor),
      captureOverlays: bool(settings.capture_overlays),
      limitFramerate: bool(settings.limit_framerate),
      hookRate: number(settings.hook_rate),
    });
  }
  walk(programName, true, 0, new Set());
  return {
    source: 'persisted_collection_not_live',
    collection: data.name === OBS_COLLECTION ? 'mizar' : 'other',
    programScene: sceneId(programName),
    programSceneKnown: programName !== null,
    previewScene: sceneId(data.current_scene),
    captureSources: captures,
    traversalLimited: visited >= 64,
    frameHealth: 'unverified',
    hookProcessIdentity: 'not_proven',
  };
}

export interface ObsNativeLogEvent {
  readonly localTime: string;
  readonly category: 'hook' | 'renderer' | 'window_capture';
  readonly outcome: 'attempt' | 'success' | 'stopped' | 'failure' | 'retry';
  readonly source: 'mizar_capture' | 'other_capture' | null;
  readonly target: 'cs2.exe' | 'other' | null;
  readonly message: string;
}
export function projectObsNativeLogLine(line: string): ObsNativeLogEvent | null {
  const stamp = /^(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?):\s+(.*)$/.exec(line);
  if (!stamp) return null;
  const capture = /^\[(game-capture|window-capture): '(.*)'\]\s+(.*)$/.exec(stamp[2]!);
  const text = capture?.[3] ?? stamp[2]!;
  const hook = capture?.[1] === 'game-capture';
  const attempt = /^attempting to hook (?:fullscreen )?process: (.+)$/i.exec(text);
  let outcome: ObsNativeLogEvent['outcome'];
  if (hook && attempt) outcome = 'attempt';
  else if (hook && /^(?:memory|shared texture) capture successful$/i.test(text))
    outcome = 'success';
  else if (hook && /^capture stopped$/i.test(text)) outcome = 'stopped';
  else if (hook && /^hook not loaded yet, retrying\.\.$/i.test(text)) outcome = 'retry';
  else if (
    capture &&
    /^(?:hook_direct:|hook:|init_hook_info:|init_pipe:|Failed to|failed to|could not|Game capture file|Game capture .*not found|\[WGC\])/i.test(
      text,
    ) &&
    /fail|error|not found|could not|unavailable/i.test(text)
  )
    outcome = 'failure';
  else if (
    !capture &&
    /^(?:D3D11|DXGI|Failed to create D3D|Failed to initialize video|gs_create|device_create)/i.test(
      text,
    ) &&
    /fail|error|removed|lost/i.test(text)
  )
    outcome = 'failure';
  else return null;
  return {
    localTime: stamp[1]!,
    category: hook ? 'hook' : capture ? 'window_capture' : 'renderer',
    outcome,
    source: capture ? (capture[2] === OBS_CAPTURE_INPUT ? 'mizar_capture' : 'other_capture') : null,
    target: attempt ? target(attempt[1]) : null,
    message: attempt
      ? `attempting to hook process: ${target(attempt[1]) === 'cs2.exe' ? 'cs2.exe' : '[other executable]'}`
      : redactObsNativeText(text),
  };
}

interface LogEvidence {
  slot: number;
  modifiedAt: string;
  sessionStartedAt: string;
  processAssociation: 'time_correlated' | 'unverified';
  processPid: number | null;
  obsVersion: string | null;
  runningAsAdministrator: boolean | null;
  portable: boolean | null;
  renderer: 'd3d11' | 'opengl' | null;
  truncated: boolean;
  omittedLines: number;
  events: ObsNativeLogEvent[];
}
interface RootEvidence {
  location: 'appdata_candidate' | 'portable_process';
  config: Obj | null;
  logs: LogEvidence[];
  logsStatus: 'available' | 'missing' | 'failed';
  directoryTruncated: boolean;
  fileStatus: Record<string, 'read' | 'missing' | 'failed' | 'not_selected'>;
}
export interface ObsNativeEvidence {
  collectionStatus: 'available' | 'unsupported' | 'timeout' | 'failed';
  processStatus: 'available' | 'failed' | 'unavailable';
  processes: Omit<ObsNativeProcess, 'executablePath'>[];
  roots: RootEvidence[];
  errors: ReturnType<typeof failure>[];
  limits: typeof OBS_NATIVE_LIMITS;
  exportTruncated: boolean;
  interpretation: 'read_only_evidence_not_black_screen_root_cause';
}
export function failedObsNativeEvidence(error: unknown): ObsNativeEvidence {
  return {
    collectionStatus: 'failed',
    processStatus: 'unavailable',
    processes: [],
    roots: [],
    errors: [failure('collector', error)],
    limits: OBS_NATIVE_LIMITS,
    exportTruncated: false,
    interpretation: 'read_only_evidence_not_black_screen_root_cause',
  };
}
export interface ObsNativeOptions {
  readonly platform?: NodeJS.Platform;
  readonly appData?: string;
  readonly now?: () => number;
  readonly readProcesses?: () => Promise<readonly ObsNativeProcess[]>;
  readonly budgetMs?: number;
}

/** Fixed local OBS roots only. No browser paths, network, settings mutations or arbitrary profile export. */
export async function collectObsNativeEvidence(
  options: ObsNativeOptions = {},
): Promise<ObsNativeEvidence> {
  const evidence: ObsNativeEvidence = {
    collectionStatus: 'available',
    processStatus: 'unavailable',
    processes: [],
    roots: [],
    errors: [],
    limits: OBS_NATIVE_LIMITS,
    exportTruncated: false,
    interpretation: 'read_only_evidence_not_black_screen_root_cause',
  };
  if ((options.platform ?? process.platform) !== 'win32')
    return { ...evidence, collectionStatus: 'unsupported' };
  const now = options.now ?? Date.now;
  let cancelled = false;
  const check = () => {
    if (cancelled) throw new Error('obs_native_deadline');
  };
  const error = (phase: string, e: unknown) => {
    check();
    if (evidence.errors.length < 8) evidence.errors.push(failure(phase, e));
  };
  async function read(root: string, parts: string[], limit: number, tail = false, header = false) {
    check();
    let path = root;
    // Reject reparse/symlink components, including the OBS root itself.
    for (const part of ['', ...parts]) {
      path = part ? join(path, part) : path;
      const stat = await lstat(path);
      check();
      if (stat.isSymbolicLink())
        throw Object.assign(new Error('OBS evidence path is a symbolic link'), { code: 'EUNSAFE' });
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      check();
      if (!stat.isFile())
        throw Object.assign(new Error('OBS evidence is not a regular file'), { code: 'EUNSAFE' });
      if (!tail && !header && stat.size > limit)
        throw Object.assign(new Error('OBS evidence exceeds the read limit'), { code: 'ETOOBIG' });
      const size = Math.min(stat.size, limit),
        buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        size,
        tail ? Math.max(0, stat.size - size) : 0,
      );
      check();
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      return {
        text: tail && stat.size > size ? text.slice(text.indexOf('\n') + 1) : text,
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    } finally {
      await handle.close();
    }
  }
  async function optional(
    root: string,
    parts: string[],
    limit: number,
    statuses?: RootEvidence['fileStatus'],
    role = 'portable_marker',
  ) {
    try {
      const result = await read(root, parts, limit);
      if (statuses) statuses[role] = 'read';
      return result;
    } catch (e) {
      if (statuses) statuses[role] = obj(e).code === 'ENOENT' ? 'missing' : 'failed';
      if (obj(e).code !== 'ENOENT') error(role, e);
      return null;
    }
  }
  async function collect() {
    let processes: readonly ObsNativeProcess[] = [];
    try {
      processes = await (options.readProcesses ?? readObsNativeProcesses)();
      check();
      evidence.processes = processes.slice(0, 8).map((p) => ({
        role: p.role,
        pid: p.pid,
        startedAt: p.startedAt,
        elevated: p.elevated,
        elevationError: p.elevationError,
        allowThirdParty: p.allowThirdParty,
        portable: p.portable,
      }));
      evidence.processStatus = 'available';
    } catch (e) {
      error('process_read', e);
      evidence.processStatus = 'failed';
    }
    const roots = new Map<string, RootEvidence['location']>();
    const appData = options.appData ?? process.env.APPDATA;
    if (appData) roots.set(join(appData, 'obs-studio'), 'appdata_candidate');
    for (const p of processes) {
      if (
        p.role !== 'obs' ||
        !p.executablePath ||
        !/^obs(?:64|32)\.exe$/i.test(basename(p.executablePath))
      )
        continue;
      const portableRoot = dirname(dirname(dirname(p.executablePath)));
      const marker = await optional(portableRoot, ['portable_mode.txt'], 4096);
      if (p.portable === true || marker)
        roots.set(join(portableRoot, 'config', 'obs-studio'), 'portable_process');
    }
    for (const [root, location] of [...roots].slice(0, OBS_NATIVE_LIMITS.roots)) {
      check();
      const result: RootEvidence = {
        location,
        config: null,
        logs: [],
        logsStatus: 'missing',
        directoryTruncated: false,
        fileStatus: { profile: 'not_selected', collection: 'not_selected' },
      };
      evidence.roots.push(result);
      const global = await optional(root, ['global.ini'], 65536, result.fileStatus, 'global'),
        user = await optional(root, ['user.ini'], 65536, result.fileStatus, 'user');
      const settings = { ...(global ? ini(global.text) : {}), ...(user ? ini(user.text) : {}) };
      const basic = settings.Basic ?? settings.BasicWindow ?? {};
      const profile = component(basic.ProfileDir)
        ? await optional(
            root,
            ['basic', 'profiles', basic.ProfileDir, 'basic.ini'],
            65536,
            result.fileStatus,
            'profile',
          )
        : null;
      const collection = component(basic.SceneCollectionFile)
        ? await optional(
            root,
            ['basic', 'scenes', basic.SceneCollectionFile + '.json'],
            OBS_NATIVE_LIMITS.configBytes,
            result.fileStatus,
            'collection',
          )
        : null;
      const profileIni = profile ? ini(profile.text) : {};
      let saved: ReturnType<typeof projectObsSavedCollection> | null = null;
      if (collection) {
        try {
          saved = projectObsSavedCollection(JSON.parse(collection.text));
        } catch {
          result.fileStatus.collection = 'failed';
          error(
            'collection_parse',
            new Error('OBS saved collection JSON is invalid; content omitted'),
          );
        }
      }
      result.config = {
        source: 'persisted_files_not_live',
        globalRead: !!global,
        userRead: !!user,
        profileRead: !!profile,
        collectionRead: !!collection,
        video: Object.fromEntries(
          [
            'BaseCX',
            'BaseCY',
            'OutputCX',
            'OutputCY',
            'FPSNum',
            'FPSDen',
            'FPSType',
            'FPSCommon',
          ].map((k) => [k, configInt(profileIni.Video?.[k])]),
        ),
        renderer: /Direct3D\s*11/i.test(settings.Video?.Renderer ?? '')
          ? 'd3d11'
          : /OpenGL/i.test(settings.Video?.Renderer ?? '')
            ? 'opengl'
            : null,
        collection: saved,
      };
      try {
        const dirPath = join(root, 'logs'),
          stat = await lstat(root);
        check();
        if (stat.isSymbolicLink() || (await lstat(dirPath)).isSymbolicLink())
          throw Object.assign(new Error('OBS log directory is a symbolic link'), {
            code: 'EUNSAFE',
          });
        const directory = await opendir(dirPath);
        const names: string[] = [];
        try {
          for (let n = 0; n < OBS_NATIVE_LIMITS.directoryEntries; n++) {
            const entry = await directory.read();
            check();
            if (!entry) break;
            if (n === OBS_NATIVE_LIMITS.directoryEntries - 1) result.directoryTruncated = true;
            if (entry.isFile() && /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/.test(entry.name))
              names.push(entry.name);
          }
        } finally {
          await directory.close();
        }
        result.logsStatus = 'available';
        for (const name of names.sort().reverse().slice(0, OBS_NATIVE_LIMITS.logFiles)) {
          const tail = await read(root, ['logs', name], OBS_NATIVE_LIMITS.logTailBytes, true);
          if (tail.mtime > now() + 60000 || now() - tail.mtime > OBS_NATIVE_LIMITS.logAgeMs)
            continue;
          const header = (
            await read(root, ['logs', name], OBS_NATIVE_LIMITS.logHeaderBytes, false, true)
          ).text;
          const sessionDate = new Date(
            name.slice(0, 10) + 'T' + name.slice(11, 19).replaceAll('-', ':'),
          );
          if (!Number.isFinite(sessionDate.getTime())) continue;
          const startedAt = sessionDate.toISOString();
          const associatedProcesses = processes.filter(
            (p) =>
              p.role === 'obs' &&
              p.startedAt &&
              Math.abs(Date.parse(p.startedAt) - Date.parse(startedAt)) < 10000,
          );
          const associated = associatedProcesses.length === 1 ? associatedProcesses[0] : undefined;
          const log: LogEvidence = {
            slot: result.logs.length,
            modifiedAt: new Date(tail.mtime).toISOString(),
            sessionStartedAt: startedAt,
            processAssociation: associated ? 'time_correlated' : 'unverified',
            processPid: associated?.pid ?? null,
            obsVersion: /\bOBS (\d{1,3}\.\d{1,3}\.\d{1,3})\b/.exec(header)?.[1] ?? null,
            runningAsAdministrator: /Running as administrator:\s*(true|false)/i.test(header)
              ? /Running as administrator:\s*true/i.test(header)
              : null,
            portable: /Portable mode:\s*(true|false)/i.test(header)
              ? /Portable mode:\s*true/i.test(header)
              : null,
            renderer: /(?:D3D11|Direct3D 11)/i.test(header)
              ? 'd3d11'
              : /OpenGL/i.test(header)
                ? 'opengl'
                : null,
            truncated: tail.size > OBS_NATIVE_LIMITS.logTailBytes,
            omittedLines: 0,
            events: [],
          };
          for (const line of tail.text.split(/\r?\n/)) {
            const event = projectObsNativeLogLine(line);
            if (!event) {
              log.omittedLines++;
              continue;
            }
            const date = new Date(tail.mtime),
              [hh, mm, ss] = event.localTime.split(':').map(Number);
            date.setHours(hh!, mm, ss, 0);
            if (date.getTime() > tail.mtime + 60000) date.setDate(date.getDate() - 1);
            if (
              now() - date.getTime() > OBS_NATIVE_LIMITS.eventAgeMs ||
              date.getTime() > now() + 60000
            ) {
              log.omittedLines++;
              continue;
            }
            log.events.push(event);
          }
          if (log.events.length > OBS_NATIVE_LIMITS.eventsPerLog) {
            log.omittedLines += log.events.length - OBS_NATIVE_LIMITS.eventsPerLog;
            const lastFailure = [...log.events].reverse().find((e) => e.outcome === 'failure');
            log.events = log.events.slice(-OBS_NATIVE_LIMITS.eventsPerLog);
            if (lastFailure && !log.events.includes(lastFailure)) log.events[0] = lastFailure;
            log.truncated = true;
          }
          result.logs.push(log);
        }
      } catch (e) {
        result.logsStatus = obj(e).code === 'ENOENT' ? 'missing' : 'failed';
        if (result.logsStatus === 'failed') error('logs_read', e);
      }
    }
    check();
    return evidence;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    collect().catch((e) => {
      if (!cancelled) error('collector', e);
      return { ...evidence, collectionStatus: 'failed' as const };
    }),
    new Promise<ObsNativeEvidence>((resolve) => {
      timer = setTimeout(() => {
        cancelled = true;
        resolve({ ...structuredClone(evidence), collectionStatus: 'timeout' });
      }, options.budgetMs ?? OBS_NATIVE_LIMITS.collectionMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  const exported = structuredClone(result);
  while (Buffer.byteLength(JSON.stringify(exported, null, 2)) > OBS_NATIVE_LIMITS.exportBytes) {
    const logs = exported.roots
      .flatMap((r) => r.logs)
      .filter((l) => l.events.length > 2)
      .sort((a, b) => b.events.length - a.events.length);
    const log = logs[0];
    if (!log) break;
    const lastFailure = [...log.events].reverse().find((e) => e.outcome === 'failure');
    const index = log.events.findIndex((e, i) => i < log.events.length - 1 && e !== lastFailure);
    if (index < 0) break;
    log.events.splice(index, 1);
    log.omittedLines++;
    log.truncated = true;
    exported.exportTruncated = true;
  }
  return exported;
}
