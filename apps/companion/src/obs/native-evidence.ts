import { constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
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
  logHeaderBytes: 8192,
  logScanBytes: 8 * 1024 * 1024,
  lineBytes: 8192,
  attachmentBytesPerLog: 128 * 1024,
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
  return redactDiagnosticText(
    text.replace(/^.*\bstream[_-]?key["']?\s*[:=].*$/gim, '[credential-bearing line redacted]'),
  )
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\[(?:game|window|monitor)-capture:.*?\]\s*/gi, '[capture] ')
    .replace(/(['"])[^'"\r\n]*\1/g, '[quoted value]')
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n,;)]*/gi, '[path]')
    .replace(/\/(?:home|Users|tmp|var|etc)\/[^\s,;)]*/g, '[path]')
    .replace(
      /^((?:hook_direct:\s*)?could not open process:\s*)(.*?)(\s+\(-?\d+\))?$/i,
      (_match, prefix: string, executable: string, suffix: string | undefined) =>
        prefix +
        (/^(?:cs2|obs32|obs64)\.exe$/i.test(executable) ? executable : '[executable]') +
        (suffix ?? ''),
    )
    .replace(/^(cannot capture )(.+)( due to being blacklisted)$/i, '$1[executable]$3')
    .replace(/[\p{L}\p{N}\p{M}_.-]+\.exe\b/giu, (executable) =>
      /^(?:cs2|obs32|obs64)\.exe$/i.test(executable) ? executable : '[executable]',
    )
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
  readonly occurredAt?: string | null;
  readonly operation?: string | null;
  readonly category: 'hook' | 'renderer' | 'window_capture';
  readonly outcome: 'attempt' | 'success' | 'stopped' | 'failure' | 'retry';
  readonly source: 'mizar_capture' | 'other_capture' | null;
  readonly target: 'cs2.exe' | 'other' | null;
  readonly message: string;
  readonly reason:
    | 'inject_helper_failed'
    | 'hook_version_incompatible'
    | 'process_open_failed'
    | 'hook_file_locked'
    | 'hook_file_update_failed'
    | 'target_blacklisted'
    | 'hook_file_missing'
    | 'hook_file_load_failed'
    | 'mutex_create_failed'
    | 'mutex_open_failed'
    | 'window_process_query_failed'
    | 'hook_event_open_failed'
    | 'capture_failure'
    | 'renderer_failure'
    | null;
  readonly code: number | null;
  readonly codeHex: string | null;
  readonly hookVersions: { dll: string; plugin: string } | null;
}
function nativeErrorCode(value: string | undefined): number | null {
  const code = value === undefined ? NaN : Number(value);
  return Number.isSafeInteger(code) && code >= -2147483648 && code <= 4294967295 ? code : null;
}
// Fixed OBS logger text carries operations and reasons; suffixes can contain private paths/body.
const CAPTURE_FAILURE_OPERATIONS = [
  ['Failed to create keepalive mutex', 'keepalive_mutex_create', 'mutex_create_failed'],
  ['failed to open texture mutexes', 'texture_mutex_open', 'mutex_open_failed'],
  [
    'error acquiring, failed to get window thread/process ids',
    'window_thread_process_ids',
    'window_process_query_failed',
  ],
  ['error acquiring, failed to get window information', 'window_information', 'capture_failure'],
  ['Failed to create inject helper process', 'inject_helper_create', 'capture_failure'],
  ['Could not convert file name to wide string', 'hook_file_name_convert', 'capture_failure'],
  ['init_hook_info: get_hook_info failed', 'hook_info_open', 'capture_failure'],
  ['init_hook_info: failed to map data view', 'hook_info_map_view', 'capture_failure'],
  [
    'init_hook_info: shared texture capture unavailable',
    'shared_texture_support',
    'capture_failure',
  ],
  ['init_pipe: failed to start pipe', 'hook_pipe_start', 'capture_failure'],
  ['hook_direct: could not convert string', 'hook_target_string_convert', 'capture_failure'],
  ['hook_direct: could not make absolute path', 'hook_target_path_resolve', 'capture_failure'],
  ['hook_direct: inject failed', 'hook_direct_inject', 'capture_failure'],
  ...['restart', 'stop', 'init', 'ready', 'exit'].map(
    (name) =>
      [
        `init_events: failed to get hook_${name} event`,
        `hook_${name}_event_open`,
        'hook_event_open_failed',
      ] as const,
  ),
  ['init_capture_data: failed to open file mapping', 'capture_mapping_open', 'capture_failure'],
  ['init_capture_data: failed to map data view', 'capture_mapping_view', 'capture_failure'],
  [
    'init_shmem_capture: failed to create extra texrender',
    'shmem_extra_texrender_create',
    'capture_failure',
  ],
  ['init_shmem_capture: failed to create texture', 'shmem_texture_create', 'capture_failure'],
  [
    'init_shtex_capture: failed to create extra texrender',
    'shtex_extra_texrender_create',
    'capture_failure',
  ],
  [
    'init_shtex_capture: failed to create extra texture',
    'shtex_extra_texture_create',
    'capture_failure',
  ],
  [
    'init_shtex_capture: failed to open shared handle',
    'shtex_shared_handle_open',
    'capture_failure',
  ],
  ['init_capture_data failed', 'capture_data_initialize', 'capture_failure'],
] as const;

export function projectObsNativeLogLine(line: string): ObsNativeLogEvent | null {
  const stamp = /^(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?):\s+(.*)$/.exec(line);
  if (!stamp) return null;
  const capture = /^\[(game-capture|window-capture): '(.*)'\]\s+(.*)$/.exec(stamp[2]!);
  const text = capture?.[3] ?? stamp[2]!;
  const hook = capture?.[1] === 'game-capture';
  const attempt = /^attempting to hook (?:fullscreen )?process: (.+)$/i.exec(text);
  const openFailure =
    /^(?:hook_direct:\s*)?could not open process:\s*(.*?)(?:\s+\((-?\d{1,11})\))?$/i.exec(text);
  const updateFailure = /^update_hook_file:\s*failed to update .+ \((-?\d{1,11})\)$/i.exec(text);
  const globalSuccess = !capture && /^d3d11 shared texture capture successful$/i.test(text);
  const helperFailure = /^inject process failed:\s*(-?\d{1,11})$/i.exec(text);
  const versionFailure =
    /^cannot initialize hook, DLL hook version is (\d{1,5}\.\d{1,5}), current plugin hook major version is (\d{1,5}\.\d{1,5})$/i.exec(
      text,
    );
  const rendererFailure =
    !capture &&
    /^(?:(?:device|gs)_[a-z0-9_]+ \(D3D11\):|Device Removed Reason:|HasBadNV12Output failed:|Failed (?:querying WDDM|enumerating devices)|IDXGIOutput6::GetDesc1 failed:|gs_vertexbuffer_flush:)/i.test(
      text,
    );
  const hresult = rendererFailure
    ? /(?:\((?:0x)?([a-f0-9]{8})\)|(?:Reason:|failed:|caps:)\s*(?:0x)?([a-f0-9]{8}))\s*$/i.exec(
        text,
      )
    : null;
  const codeHex = hresult ? `0x${(hresult[1] ?? hresult[2])!.toUpperCase()}` : null;
  let outcome: ObsNativeLogEvent['outcome'];
  if (hook && attempt) outcome = 'attempt';
  else if (
    globalSuccess ||
    (hook && /^(?:d3d11 )?(?:memory|shared texture) capture successful$/i.test(text))
  )
    outcome = 'success';
  else if (
    hook &&
    /^(?:capture stopped|capture window no longer exists, terminating capture)$/i.test(text)
  )
    outcome = 'stopped';
  else if (hook && /^hook not loaded yet, retrying\.\.$/i.test(text)) outcome = 'retry';
  else if (hook && (helperFailure || versionFailure || /^init_capture_data failed$/i.test(text)))
    outcome = 'failure';
  else if (
    capture &&
    /^(?:hook_direct:|hook:|init_[a-z_]+:|error acquiring|cannot capture|Failed to|failed to|could not|Game capture file|Game capture .*not found|\[WGC\])/i.test(
      text,
    ) &&
    /fail|error|not found|could not|unavailable|blacklisted/i.test(text)
  )
    outcome = 'failure';
  else if (updateFailure) outcome = 'failure';
  else if (rendererFailure) outcome = 'failure';
  else if (
    !capture &&
    /^(?:D3D11|DXGI|Failed to create D3D|Failed to initialize video|gs_create|device_create)/i.test(
      text,
    ) &&
    /fail|error|removed|lost/i.test(text)
  )
    outcome = 'failure';
  else return null;
  const fixed = capture
    ? CAPTURE_FAILURE_OPERATIONS.find(([prefix]) => {
        if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return false;
        return /^(?:$|[:.\s])/.test(text.slice(prefix.length));
      })
    : undefined;
  const blacklist = /^cannot capture .+ due to being blacklisted$/i.test(text);
  const missingFile = /^Game capture (?:file )?.+ not found\.?$/i.test(text);
  const loadFile = /^Game capture file .+ could not be loaded(?:[.:]|$)/i.test(text);
  const operation = attempt
    ? 'process_hook_attempt'
    : openFailure
      ? 'process_open'
      : updateFailure
        ? 'hook_file_update'
        : blacklist
          ? 'capture_target_policy'
          : missingFile
            ? 'hook_file_lookup'
            : loadFile
              ? 'hook_file_load'
              : (fixed?.[1] ??
                (helperFailure
                  ? 'inject_helper_exit'
                  : versionFailure
                    ? 'hook_version_check'
                    : null));
  let message: string;
  if (attempt)
    message = `attempting to hook process: ${target(attempt[1]) === 'cs2.exe' ? 'cs2.exe' : '[other executable]'}`;
  else if (updateFailure)
    message = `update_hook_file: failed to update [hook file] (${updateFailure[1]})`;
  else if (openFailure)
    message = redactObsNativeText(
      `${text.startsWith('hook_direct:') ? 'hook_direct: ' : ''}could not open process: ${openFailure[1]}${openFailure[2] ? ` (${openFailure[2]})` : ''}`,
    );
  else if (blacklist) message = 'cannot capture [executable] due to being blacklisted';
  else if (missingFile) message = 'Game capture [hook file] not found.';
  else if (loadFile) message = 'Game capture [hook file] could not be loaded.';
  else if (fixed) {
    message = fixed[0];
    const numeric = /^:\s*(-?\d{1,11})(?=[.\s]|$)/.exec(text.slice(fixed[0].length))?.[1];
    if (numeric) message += `: ${numeric}`;
  } else if (outcome === 'failure') {
    const logger = /^(device_texture_create|gs_vertexbuffer_flush)(?=[:\s])/i.exec(text)?.[1];
    message = `${logger ?? (!capture ? 'renderer' : 'capture')} failure`;
    if (helperFailure) message = `inject process failed: ${helperFailure[1]}`;
    else if (versionFailure)
      message = `cannot initialize hook, DLL hook version is ${versionFailure[1]}, current plugin hook major version is ${versionFailure[2]}`;
    else if (codeHex) message += `; HRESULT ${codeHex}`;
  } else message = redactObsNativeText(text);
  return {
    localTime: stamp[1]!,
    operation,
    category:
      hook || updateFailure || globalSuccess ? 'hook' : capture ? 'window_capture' : 'renderer',
    outcome,
    source: capture ? (capture[2] === OBS_CAPTURE_INPUT ? 'mizar_capture' : 'other_capture') : null,
    target: attempt ? target(attempt[1]) : openFailure ? target(openFailure[1]) : null,
    reason:
      outcome !== 'failure'
        ? null
        : updateFailure
          ? nativeErrorCode(updateFailure[1]) === 32
            ? 'hook_file_locked'
            : 'hook_file_update_failed'
          : blacklist
            ? 'target_blacklisted'
            : missingFile
              ? 'hook_file_missing'
              : loadFile
                ? 'hook_file_load_failed'
                : fixed
                  ? fixed[2]
                  : openFailure
                    ? 'process_open_failed'
                    : helperFailure
                      ? 'inject_helper_failed'
                      : versionFailure
                        ? 'hook_version_incompatible'
                        : !capture
                          ? 'renderer_failure'
                          : 'capture_failure',
    codeHex,
    code: codeHex
      ? Number.parseInt(codeHex.slice(2), 16)
      : outcome === 'failure' && !versionFailure
        ? nativeErrorCode(
            updateFailure?.[1] ??
              openFailure?.[2] ??
              helperFailure?.[1] ??
              /[:(]\s*(-?\d{1,11})\)?\.?$/.exec(text)?.[1],
          )
        : null,
    hookVersions: versionFailure ? { dll: versionFailure[1]!, plugin: versionFailure[2]! } : null,
    message,
  };
}

interface LogEvidence {
  slot: number;
  modifiedAt: string;
  sessionStartedAt: string;
  timestampStatus?: 'ordered' | 'uncertain';
  processAssociation: 'time_correlated' | 'unverified';
  processPid: number | null;
  obsVersion: string | null;
  runningAsAdministrator: boolean | null;
  portable: boolean | null;
  renderer: 'd3d11' | 'opengl' | null;
  truncated: boolean;
  omittedLines: number;
  events: ObsNativeLogEvent[];
  scan?: {
    fileBytes: number;
    readBytes: number;
    missingByteRange: [number, number] | null;
    reasons: string[];
    ignoredLines: number;
    oversizedLines: number;
    retainedEvents: number;
    omittedEvents: number;
  };
  latestCaptureEvent?: ObsNativeLogEvent | null;
  latestCaptureFailure?: ObsNativeLogEvent | null;
  failureCounts?: Record<string, number>;
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
  logAttachments?: {
    root: number;
    slot: number;
    format: 'allowlisted-technical-events/1';
    events: ObsNativeLogEvent[];
    omittedEvents: number;
    firstOmittedLocalTime: string | null;
    lastOmittedLocalTime: string | null;
  }[];
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
  readonly includeRelatedLogs?: boolean;
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
  async function guardedPath(path: string) {
    if (!isAbsolute(path))
      throw Object.assign(new Error('OBS evidence path is not absolute'), { code: 'EUNSAFE' });
    const paths: string[] = [];
    for (let current = path; ; current = dirname(current)) {
      if (paths.length >= 64)
        throw Object.assign(new Error('OBS evidence path depth exceeds limit'), {
          code: 'ETOOBIG',
        });
      paths.unshift(current);
      if (dirname(current) === current) break;
    }
    const chain = [];
    for (const current of paths) {
      const stat = await lstat(current);
      check();
      if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory()))
        throw Object.assign(new Error('OBS evidence ancestor is not a regular directory'), {
          code: 'EUNSAFE',
        });
      chain.push({ path: current, stat });
    }
    return chain;
  }
  async function unchanged(chain: Awaited<ReturnType<typeof guardedPath>>) {
    for (const previous of chain) {
      const current = await lstat(previous.path);
      check();
      if (
        current.isSymbolicLink() ||
        current.ino !== previous.stat.ino ||
        current.dev !== previous.stat.dev
      )
        throw Object.assign(new Error('OBS evidence path changed during read'), {
          code: 'ECHANGED',
        });
    }
  }
  async function read(
    root: string,
    parts: string[],
    limit: number,
    tail = false,
    header = false,
    visit?: (line: string) => void,
  ) {
    check();
    const path = join(root, ...parts);
    const chain = await guardedPath(path);
    const before = chain[chain.length - 1]!.stat;
    if (!before.isFile())
      throw Object.assign(new Error('OBS evidence is not a regular file'), { code: 'EUNSAFE' });
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      check();
      if (stat.ino !== before.ino || stat.dev !== before.dev)
        throw Object.assign(new Error('OBS evidence file changed before open'), {
          code: 'ECHANGED',
        });
      await unchanged(chain);
      if (!stat.isFile())
        throw Object.assign(new Error('OBS evidence is not a regular file'), { code: 'EUNSAFE' });
      if (!tail && !header && stat.size > limit)
        throw Object.assign(new Error('OBS evidence exceeds the read limit'), { code: 'ETOOBIG' });
      if (visit) {
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(65536);
        const end = Math.min(stat.size, limit);
        let position = 0,
          pending = '',
          dropping = false,
          oversizedLines = 0;
        const lines = (text: string) => {
          for (const part of text.split(/(?<=\n)/)) {
            if (!dropping) pending += part;
            if (pending.length > OBS_NATIVE_LIMITS.lineBytes) {
              pending = '';
              dropping = true;
            }
            if (part.endsWith('\n')) {
              if (dropping) oversizedLines++;
              else visit(pending.replace(/\r?\n$/, ''));
              pending = '';
              dropping = false;
            }
          }
        };
        while (position < end) {
          check();
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, end - position),
            position,
          );
          if (!bytesRead) break;
          position += bytesRead;
          lines(decoder.write(buffer.subarray(0, bytesRead)));
        }
        lines(decoder.end());
        if (position === stat.size && pending && !dropping) visit(pending);
        else if (position === stat.size && dropping) oversizedLines++;
        await unchanged(chain);
        return {
          text: '',
          size: stat.size,
          mtime: stat.mtimeMs,
          readBytes: position,
          oversizedLines,
        };
      }
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
      let portable = p.portable === true;
      for (const marker of [
        'portable_mode',
        'obs_portable_mode',
        'portable_mode.txt',
        'obs_portable_mode.txt',
      ]) {
        if (portable) break;
        portable = !!(await optional(portableRoot, [marker], 4096));
      }
      if (portable) roots.set(join(portableRoot, 'config', 'obs-studio'), 'portable_process');
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
      const basic = { ...settings.BasicWindow, ...settings.Basic };
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
            ['basic', 'scenes', basic.SceneCollectionFile.replace(/\.json$/i, '') + '.json'],
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
        const dirPath = join(root, 'logs');
        const directoryChain = await guardedPath(dirPath);
        const directory = await opendir(dirPath);
        const names: string[] = [];
        try {
          await unchanged(directoryChain);
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
          const tail = await read(
            root,
            ['logs', name],
            OBS_NATIVE_LIMITS.logHeaderBytes,
            false,
            true,
          );
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
            truncated: false,
            omittedLines: 0,
            events: [],
          };
          const attachment: NonNullable<ObsNativeEvidence['logAttachments']>[number] = {
            root: evidence.roots.length - 1,
            slot: log.slot,
            format: 'allowlisted-technical-events/1',
            events: [],
            omittedEvents: 0,
            firstOmittedLocalTime: null,
            lastOmittedLocalTime: null,
          };
          let attachmentBytes = 0,
            eventCount = 0;
          const failures = new Map<string, ObsNativeLogEvent>();
          log.failureCounts = {};
          log.latestCaptureEvent = null;
          log.latestCaptureFailure = null;
          const clockDate = new Date(sessionDate);
          let previousClock =
            sessionDate.getHours() * 3600000 +
            sessionDate.getMinutes() * 60000 +
            sessionDate.getSeconds() * 1000;
          let chronologyKnown = true;
          const lineDate = (line: string) => {
            const stamp = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?:/.exec(line);
            if (!stamp) return null;
            const hour = Number(stamp[1]),
              minute = Number(stamp[2]),
              second = Number(stamp[3]),
              millis = Number((stamp[4] ?? '').padEnd(3, '0'));
            if (hour > 23 || minute > 59 || second > 59) {
              chronologyKnown = false;
              return null;
            }
            const clock = hour * 3600000 + minute * 60000 + second * 1000 + millis;
            if (clock < previousClock - 1000) {
              if (previousClock >= 20 * 3600000 && clock <= 4 * 3600000)
                clockDate.setDate(clockDate.getDate() + 1);
              else chronologyKnown = false;
            }
            previousClock = clock;
            clockDate.setHours(hour, minute, second, millis);
            if (clockDate.getHours() !== hour || clockDate.getMinutes() !== minute)
              chronologyKnown = false;
            if (
              clockDate.getTime() < sessionDate.getTime() - 1000 ||
              clockDate.getTime() > tail.mtime + 60000
            )
              chronologyKnown = false;
            return chronologyKnown ? clockDate.toISOString() : null;
          };
          const scan = await read(
            root,
            ['logs', name],
            OBS_NATIVE_LIMITS.logScanBytes,
            false,
            true,
            (line) => {
              const occurredAt = lineDate(line);
              const parsed = projectObsNativeLogLine(line);
              const event = parsed ? { ...parsed, occurredAt } : null;
              if (!event) {
                log.omittedLines++;
                return;
              }
              eventCount++;
              if (event.outcome === 'failure') {
                const key = `${event.reason}:${event.code}:${event.source}:${event.target}${event.operation ? `:${event.operation}` : ''}`;
                if (Object.keys(log.failureCounts!).length < 64 || key in log.failureCounts!)
                  log.failureCounts![key] = (log.failureCounts![key] ?? 0) + 1;
                failures.delete(key);
                failures.set(key, event);
                if (failures.size > 12) failures.delete(failures.keys().next().value!);
              }
              // Unrelated custom capture sources cannot alarm or recover Mizar capture.
              if (
                event.category === 'hook' &&
                (event.source === 'mizar_capture' ||
                  event.reason === 'hook_file_locked' ||
                  event.reason === 'hook_file_update_failed' ||
                  (event.source === null && event.outcome === 'success'))
              ) {
                log.latestCaptureEvent = event;
                if (event.outcome === 'failure') log.latestCaptureFailure = event;
                else if (event.outcome === 'success') log.latestCaptureFailure = null;
              }
              log.events.push(event);
              if (log.events.length > OBS_NATIVE_LIMITS.eventsPerLog) log.events.shift();
              if (options.includeRelatedLogs) {
                // The parser's canonical technical messages exclude arbitrary raw bodies.
                const technical = event;
                const bytes =
                  Buffer.byteLength(
                    JSON.stringify(technical, null, 2).replace(/^/gm, '          '),
                  ) + 2;
                if (attachmentBytes + bytes <= OBS_NATIVE_LIMITS.attachmentBytesPerLog) {
                  attachment.events.push(technical);
                  attachmentBytes += bytes;
                } else {
                  attachment.omittedEvents++;
                  attachment.firstOmittedLocalTime ??= event.localTime;
                  attachment.lastOmittedLocalTime = event.localTime;
                }
              }
            },
          );
          log.timestampStatus = chronologyKnown ? 'ordered' : 'uncertain';
          const protectedEvents = [...failures.values()];
          const recent = log.events
            .filter((e) => !protectedEvents.includes(e))
            .slice(-(OBS_NATIVE_LIMITS.eventsPerLog - protectedEvents.length));
          log.events = [...protectedEvents, ...recent];
          log.truncated =
            scan.size > (scan.readBytes ?? 0) ||
            eventCount > log.events.length ||
            !!scan.oversizedLines;
          log.scan = {
            fileBytes: scan.size,
            readBytes: scan.readBytes ?? 0,
            missingByteRange:
              scan.size > (scan.readBytes ?? 0) ? [scan.readBytes ?? 0, scan.size] : null,
            reasons: [
              ...(scan.size > (scan.readBytes ?? 0) ? ['scan_byte_limit'] : []),
              ...(eventCount > log.events.length ? ['summary_event_limit'] : []),
              ...(scan.oversizedLines ? ['oversized_lines'] : []),
            ],
            ignoredLines: log.omittedLines,
            oversizedLines: scan.oversizedLines ?? 0,
            retainedEvents: log.events.length,
            omittedEvents: eventCount - log.events.length,
          };
          log.omittedLines += eventCount - log.events.length;
          if (options.includeRelatedLogs) (evidence.logAttachments ??= []).push(attachment);
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
  return boundObsNativeEvidence(result);
}

export function boundObsNativeEvidence(result: ObsNativeEvidence): ObsNativeEvidence {
  const exported = structuredClone(result);
  const attachments = exported.logAttachments;
  delete exported.logAttachments;
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
    if (log.scan) {
      log.scan.omittedEvents++;
      log.scan.retainedEvents--;
      if (!log.scan.reasons.includes('export_byte_limit'))
        log.scan.reasons.push('export_byte_limit');
    }
    log.truncated = true;
    exported.exportTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(exported, null, 2)) > OBS_NATIVE_LIMITS.exportBytes) {
    const fallback = failedObsNativeEvidence(
      new Error('OBS native evidence exceeded export budget; details omitted'),
    );
    return {
      ...fallback,
      ...(attachments ? { logAttachments: attachments } : {}),
      exportTruncated: true,
      errors: [
        failure(
          'export_budget',
          new Error('OBS native evidence exceeded export budget; details omitted'),
        ),
      ],
    };
  }
  return attachments ? { ...exported, logAttachments: attachments } : exported;
}
