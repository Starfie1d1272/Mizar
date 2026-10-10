import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout, setTimeout } from 'node:timers';

const HISTORY_COUNT = 3;
export const PRODUCT_LOG_BYTES = 25 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;

export function startupSessionId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : randomUUID();
}

function rotate(path) {
  rmSync(`${path}.${HISTORY_COUNT}`, { force: true });
  for (let index = HISTORY_COUNT - 1; index >= 0; index--) {
    const source = index === 0 ? path : `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
}

export function safeLogText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0)
      text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)[^\r\n]+/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/gi, '$1?[redacted]')
    .replace(/rh_mizar_[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(
      /((?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|client[_-]?secret|credential|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[redacted]',
    );
}

/** Low-volume supervisor stages; reopening for each append also permits stop/reuse attempts. */
export function createSupervisorLog(stateRoot, sessionId, { maxBytes = PRODUCT_LOG_BYTES } = {}) {
  const directory = join(stateRoot, 'logs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'supervisor.ndjson');
  return (stage, fields = {}) => {
    // Logging failure must not throw from a child/stream callback and kill a live runtime.
    try {
      // Redact values before encoding so quotes/backslashes in errors remain valid NDJSON.
      const entry = `${JSON.stringify(
        { timestamp: new Date().toISOString(), startupSessionId: sessionId, stage, ...fields },
        (_key, value) => (typeof value === 'string' ? safeLogText(value) : value),
      )}\n`;
      const bytes = Buffer.from(entry);
      if (bytes.length > maxBytes) return;
      if (existsSync(path) && statSync(path).size + bytes.length > maxBytes) rotate(path);
      appendFileSync(path, bytes, { mode: 0o600 });
    } catch {
      // The Desktop log/native failure surface remains an independent diagnostic path.
    }
  };
}

/** Keep the current segment and three previous segments, rotating during a running session. */
export function createCompanionLog(
  stateRoot,
  name,
  sessionId,
  { maxBytes = PRODUCT_LOG_BYTES, secrets = [], onFailure = () => {} } = {},
) {
  const directory = join(stateRoot, 'logs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  rotate(path);
  const header = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    startupSessionId: sessionId,
    stage: 'companion_output_start',
  })}\n`;
  writeFileSync(path, header, { mode: 0o600 });
  let size = Buffer.byteLength(header);
  let stopped = false;
  let pending = '';
  let oversized = false;
  const decoder = new StringDecoder('utf8');
  function append(text) {
    if (stopped) return;
    try {
      const bytes = Buffer.from(safeLogText(text, secrets));
      if (size + bytes.length > maxBytes) {
        rotate(path);
        writeFileSync(path, header, { mode: 0o600 });
        size = Buffer.byteLength(header);
      }
      const bounded =
        bytes.length + size > maxBytes
          ? Buffer.from('[Mizar: oversized log line omitted]\n')
          : bytes;
      appendFileSync(path, bounded);
      size += bounded.length;
    } catch (error) {
      stopped = true;
      onFailure({ name, code: error.code ?? 'LOG_WRITE_FAILED' });
    }
  }
  function consume(text) {
    for (const fragment of text.split(/(?<=\n)/)) {
      if (!oversized) {
        pending += fragment;
        if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
          pending = '';
          oversized = true;
        }
      }
      if (fragment.endsWith('\n')) {
        append(oversized ? '[Mizar: oversized log line omitted]\n' : pending);
        pending = '';
        oversized = false;
      }
    }
  }
  return {
    write(chunk) {
      if (!stopped) consume(decoder.write(chunk));
    },
    end() {
      if (stopped) return;
      consume(decoder.end());
      if (oversized) append('[Mizar: oversized log line omitted]\n');
      else if (pending) append(`${pending}\n`);
      pending = '';
    },
  };
}

/** The Desktop assigns its new supervisor to an owned Job before permitting any child spawn. */
export function awaitDesktopStart(input, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let message = '';
    const finish = (error) => {
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.pause();
      if (error) reject(error);
      else resolve();
    };
    const onEnd = () => finish(new Error('桌面启动控制通道已关闭'));
    const onError = () => finish(new Error('桌面启动控制通道失败'));
    const onData = (chunk) => {
      message += chunk.toString('utf8');
      if (message.length > 64) return finish(new Error('桌面启动控制消息无效'));
      if (!message.includes('\n')) return;
      finish(
        /^MIZAR_DESKTOP_START\r?\n$/.test(message) ? undefined : new Error('桌面启动控制消息无效'),
      );
    };
    const timer = setTimeout(() => finish(new Error('桌面启动控制通道超时')), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}
