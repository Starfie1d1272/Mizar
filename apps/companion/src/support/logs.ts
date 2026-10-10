import { boundDiagnostic, errorEvidence, redactDiagnosticText } from '../updates/diagnostics.js';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const SUPPORT_LOG_READ_BYTES = 64 * 1024;
export const SUPPORT_LOG_EVENTS = 32;
const HEADER_BYTES = 4096;
const names = ['desktop.ndjson', 'supervisor.ndjson', 'companion.log', 'companion.stderr.log'];
const stages = new Set([
  'process_start',
  'powershell',
  'cs2_launch',
  'webview2_recheck',
  'webview2_recovery_action',
  'bundle_root_resolved',
  'mutex_acquired',
  'shutdown_scope',
  'shutdown_signal',
  'runtime_job',
  'runtime_spawn',
  'runtime_job_assignment',
  'runtime_release',
  'runtime_ready',
  'webview2_preflight',
  'webview2_version',
  'tauri_begin',
  'main_window',
  'main_page_load',
  'workspace_left',
  'workspace_dock',
  'program_overlay',
  'content_protection',
  'tray',
  'setup_complete',
  'host_loop_ready',
  'runtime_startup_committed',
  'live_windows_rollback',
  'run_error',
  'startup_failed',
  'panic',
  'rollback',
  'shutdown',
  'runtime_stop',
  'runtime_job_cleanup',
  'runtime_borrowed',
  'supervisor_start',
  'runtime_reused',
  'port_conflict',
  'output_log_failed',
  'companion_spawn_begin',
  'companion_spawn_failed',
  'companion_exit',
  'runtime_error',
  'companion_rollback',
  'supervisor_complete',
  'desktop_supervision_ready',
  'artifact_verify_begin',
  'artifact_verified',
  'product_stop_begin',
  'product_stopped',
  'supervisor_error',
  'companion_output_start',
  'runtime_stopped',
]);

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function choice(value: unknown, values: readonly string[]): string | null {
  return typeof value === 'string' && values.includes(value) ? value : null;
}

export function digest(value: unknown, length: number): string | null {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e14)
    return new Date(value).toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parse(line: string): Record<string, unknown> {
  // Desktop's bounded 8 KiB error can grow under JSON escaping; the read budget
  // already caps the whole input. Retain its stage even when free text is long.
  if (line.length > SUPPORT_LOG_READ_BYTES) return {};
  try {
    return record(JSON.parse(line));
  } catch {
    return {};
  }
}

const updateStages = new Set([
  'qualification_proof_rejected',
  'check',
  'download',
  'operator_action',
  'install_plan',
  'box_metadata_fallback',
  'box_core_fallback',
  'cached_download_verify',
  'box_download',
  'github_download',
  'settings_load',
  'ready_load',
  'download_cleanup',
]);

function updateCauses(value: unknown, depth = 0): unknown[] {
  if (depth >= 4 || typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const error = record(value);
  const code =
    typeof error.code === 'string' && /^(?:E[A-Z0-9_]{1,40}|update_[a-z_]{1,50})$/.test(error.code)
      ? error.code
      : null;
  const status =
    typeof error.status === 'number' &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : null;
  return [
    {
      code,
      httpStatus: status,
      source: choice(error.source, [
        'box.nju.edu.cn',
        'github.com',
        'api.github.com',
        'release-assets.githubusercontent.com',
      ]),
    },
    ...updateCauses(error.cause, depth + 1),
    ...(Array.isArray(error.errors)
      ? error.errors.slice(0, 4).flatMap((cause) => updateCauses(cause, depth + 1))
      : []),
  ].slice(0, 12);
}

/** Project known events; exception evidence is explicitly redacted and bounded. */
function projectEvent(entry: Record<string, unknown>, session: string | null) {
  const update =
    entry.event === 'update' && typeof entry.stage === 'string' && updateStages.has(entry.stage);
  const stage =
    typeof entry.stage === 'string' && (stages.has(entry.stage) || update) ? entry.stage : null;
  const diagnostic = record(entry.diagnostic);
  const level = [10, 20, 30, 40, 50, 60].includes(Number(entry.level)) ? Number(entry.level) : null;
  if (stage === null && level === null) return null;
  const status = record(entry.res).statusCode;
  const error = typeof entry.error === 'string' ? entry.error : '';
  const osError = /\(os error (\d{1,6})\)/.exec(error);
  return {
    ...(update
      ? {
          updateCode:
            typeof entry.code === 'string' && /^update_[a-z_]{1,50}$/.test(entry.code)
              ? entry.code
              : null,
          operationId:
            typeof diagnostic.operationId === 'string' &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(diagnostic.operationId)
              ? diagnostic.operationId
              : null,
          causes: diagnostic.error === undefined ? [] : updateCauses(diagnostic.error),
        }
      : {}),
    ...(update && diagnostic.error !== undefined
      ? { localDiagnostic: boundDiagnostic(errorEvidence(diagnostic.error), 8 * 1024) }
      : {}),
    ...([
      'powershell',
      'cs2_launch',
      'webview2_preflight',
      'webview2_recheck',
      'webview2_recovery_action',
    ].includes(stage ?? '') &&
    (typeof entry.error === 'string' || typeof entry.detail === 'string')
      ? {
          localDiagnostic: redactDiagnosticText(
            typeof entry.error === 'string' ? entry.error : String(entry.detail),
          ),
        }
      : {}),
    timestamp: timestamp(entry.time ?? entry.timestamp),
    session,
    stage: stage ?? 'companion_structured_log',
    result: choice(entry.result, ['begin', 'success', 'failure', 'skipped']),
    level,
    httpStatus:
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    exitCode:
      typeof entry.code === 'number' &&
      Number.isInteger(entry.code) &&
      Math.abs(entry.code) <= 2147483648
        ? entry.code
        : null,
    osErrorCode: osError === null ? null : Number(osError[1]),
    hasLocalError:
      entry.error !== undefined || entry.err !== undefined || diagnostic.error !== undefined,
    gitSha: digest(entry.gitSha, 40),
    artifactSha256: digest(entry.artifactSha256, 64),
    appVersion:
      typeof entry.appVersion === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(entry.appVersion)
        ? entry.appVersion
        : null,
  };
}

async function readLog(directory: string, name: string, salt: string) {
  const result = {
    name,
    status: 'unavailable',
    sourceBytes: 0,
    readBytes: 0,
    tailStartByte: 0,
    truncated: false,
    omittedLines: 0,
    events: [] as NonNullable<ReturnType<typeof projectEvent>>[],
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = join(directory, name);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink())
      return { ...result, status: 'not_regular_file' };
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev)
      return { ...result, status: 'file_changed' };
    const size = stat.size;
    const start = Math.max(0, size - SUPPORT_LOG_READ_BYTES);
    const buffer = Buffer.alloc(Math.min(size, SUPPORT_LOG_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const head = Buffer.alloc(Math.min(size, HEADER_BYTES));
    const headBytes = start > 0 ? (await handle.read(head, 0, head.length, 0)).bytesRead : 0;
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = (start > 0 ? text.slice(text.indexOf('\n') + 1) : text)
      .split('\n')
      .filter(Boolean);
    const first = parse(
      (start > 0 ? head.subarray(0, headBytes).toString('utf8') : text).split('\n')[0] ?? '',
    );
    let currentSession = first.startupSessionId;
    const entries = lines
      .map((line) => {
        const entry = parse(line);
        if (typeof entry.startupSessionId === 'string') currentSession = entry.startupSessionId;
        const session =
          typeof currentSession === 'string' && currentSession.length <= 128
            ? createHash('sha256').update(salt).update(currentSession).digest('hex').slice(0, 24)
            : null;
        return projectEvent(entry, session);
      })
      .filter((event) => event !== null);
    const selected = entries.slice(-SUPPORT_LOG_EVENTS);
    const lastFailure = entries
      .map((event) => event.result === 'failure' || event.hasLocalError)
      .lastIndexOf(true);
    if (lastFailure >= 0 && lastFailure < entries.length - SUPPORT_LOG_EVENTS)
      selected[0] = entries[lastFailure]!;
    return {
      ...result,
      status: 'read',
      sourceBytes: size,
      readBytes: bytesRead + headBytes,
      tailStartByte: start,
      truncated: start > 0 || entries.length > SUPPORT_LOG_EVENTS,
      omittedLines: lines.length - Math.min(entries.length, SUPPORT_LOG_EVENTS),
      events: selected,
    };
  } catch (error) {
    return { ...result, status: record(error).code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readSupportLogs(directory: string | undefined) {
  if (directory === undefined) return [];
  const salt = randomBytes(32).toString('hex');
  const files = names.flatMap((name) => [name, ...[1, 2, 3].map((index) => `${name}.${index}`)]);
  // Sequential bounded reads avoid burst allocation or an unbounded file traversal.
  const results = [];
  for (const name of files) results.push(await readLog(directory, name, salt));
  // Reserve 64 KiB for the manifest/current snapshot. Keep each file's latest failure.
  while (Buffer.byteLength(JSON.stringify(results, null, 2)) > 192 * 1024) {
    const file = results
      .filter((item) => item.events.length > 1)
      .sort((left, right) => right.events.length - left.events.length)[0];
    if (file === undefined) break;
    const lastFailure = file.events
      .map((event) => event.result === 'failure' || event.hasLocalError)
      .lastIndexOf(true);
    file.events.splice(lastFailure === 0 ? 1 : 0, 1);
    file.truncated = true;
    file.omittedLines += 1;
  }
  return results;
}
