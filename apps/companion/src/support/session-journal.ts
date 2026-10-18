import { AsyncLocalStorage } from 'node:async_hooks';
import { BOX_READ_TOKEN } from '../updates/contract.js';
import { atomicJson, safePath } from '../resource-store/files.js';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_LIMITS = {
  segmentBytes: 8 * 1024 * 1024,
  segments: 8,
  retentionDays: 14,
  pendingBytes: 2 * 1024 * 1024,
};
const credential =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:password|passwd|token|secret|credential)|api[_-]?key|stream[_-]?key|device[_-]?code|user[_-]?code|pairing[_-]?code|ticket)$/i;
/** Preserve technical context; replace credential values, never whole events. */
export function diagnosticValue(
  value: unknown,
  key = '',
  seen = new Set<object>(),
  secrets: readonly string[] = [],
): unknown {
  if (
    key === 'ticket' &&
    typeof value === 'string' &&
    /^\[redacted-ticket:[a-f0-9]{64}\]$/.test(value)
  )
    return value;
  // A Host exit ticket is a capability, not a business identifier. Its random UUID may be linked by digest only.
  if (
    key === 'ticket' &&
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    return `[redacted-ticket:${createHash('sha256').update(value).digest('hex')}]`;
  if (credential.test(key)) return '[redacted]';
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular error]';
    seen.add(value);
    const fields = Object.fromEntries(
      Object.getOwnPropertyNames(value).map((name) => [
        name,
        (value as unknown as Record<string, unknown>)[name],
      ]),
    );
    const result = diagnosticValue(
      { ...fields, name: value.name, message: value.message, stack: value.stack },
      key,
      seen,
      secrets,
    );
    seen.delete(value);
    return result;
  }
  if (Buffer.isBuffer(value))
    return {
      bytes: value.length,
      sha256: createHash('sha256').update(value).digest('hex'),
      content: 'binary-not-collected',
    };
  if (typeof value === 'string' && /^data:[^,]+;base64,/.test(value))
    return {
      content: 'media-not-collected',
      bytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    };
  if (typeof value === 'string') {
    let cleanText = value.replaceAll(BOX_READ_TOKEN, '[redacted]');
    for (const secret of secrets)
      if (secret) cleanText = cleanText.replaceAll(secret, '[redacted]');
    if (/^\s*[{[]/.test(cleanText)) {
      try {
        return JSON.stringify(diagnosticValue(JSON.parse(cleanText), key, seen, secrets));
      } catch {
        /* A plain error or partial record remains text. */
      }
    }
    return cleanText
      .replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi, (text) => {
        try {
          const url = new URL(text);
          if (url.username || url.password) {
            url.username = '[redacted]';
            url.password = '';
          }
          for (const name of [...url.searchParams.keys()])
            if (credential.test(name) || /^(?:code|auth|key)$/i.test(name))
              url.searchParams.set(name, '[redacted]');
          if (/^rtmps?:$/.test(url.protocol)) {
            const parts = url.pathname.split('/');
            if (parts.length > 2) {
              parts[parts.length - 1] = '[redacted]';
              url.pathname = parts.join('/');
            }
          }
          return url.toString();
        } catch {
          return text;
        }
      })
      .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [redacted]')
      .replace(/rh_mizar_[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(
        /((?:password|passwd|access[_-]?token|refresh[_-]?token|token|secret|credential|api[_-]?key|stream[_-]?key|ticket)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&?#]+)/gi,
        '$1[redacted]',
      );
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((v) => diagnosticValue(v, '', seen, secrets))
    : Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          diagnosticValue(v, k === 'key' && /stream/i.test(key) ? 'streamKey' : k, seen, secrets),
        ]),
      );
  seen.delete(value);
  return result;
}

/** Small asynchronous observer of existing control/log boundaries; never runs filesystem I/O on ingress. */
export class SessionJournal {
  readonly sessionId = randomUUID();
  readonly hostStartupSessionId: string | null;
  private readonly requestContext = new AsyncLocalStorage<{
    requestId: string;
    browserOperationId: string | null;
    taskId?: string | null;
    parentOperationId?: string | null;
    trigger?: 'user' | 'system' | 'unattributed';
  }>();
  withRequest<T>(
    context: {
      requestId: string;
      browserOperationId: string | null;
      taskId?: string | null;
      parentOperationId?: string | null;
      trigger?: 'user' | 'system' | 'unattributed';
    },
    run: () => T,
  ): T {
    return this.requestContext.run(context, run);
  }
  private readonly listeners = new Set<(line: string) => void>();
  /** Background collectors must not inherit the request that happened to flush them. */
  withSystem<T>(run: () => T): T {
    return this.requestContext.exit(run);
  }
  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private sequence = 0;
  private pendingBytes = 0;
  private writer = Promise.resolve();
  private pending: {
    line: string;
    bytes: number;
    receipt?: { resolve: (sequence: number) => void; reject: (error: unknown) => void };
    sequence: number;
  }[] = [];
  private closed = false;
  private rejectedAfterClose = 0;
  private closing: Promise<void> | undefined;
  private draining = false;
  private dropped = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private writeError: unknown = null;
  private inflightRecords = 0;
  private inflightLines: string[] = [];
  private repair: { ino: number; dev: number; offset: number } | undefined;
  private size = -1;
  private initialized = false;
  private readonly identity: {
    appVersion: string | null;
    gitSha: string | null;
    artifactSha256: string | null;
  };
  private retention = { rotatedFiles: 0, rotatedBytes: 0, expiredFiles: 0, expiredBytes: 0 };
  constructor(
    private readonly directory: string,
    identity: {
      appVersion?: string | null;
      gitSha?: string | null;
      artifactSha256?: string | null;
      hostStartupSessionId?: string | null;
    } = {},
  ) {
    const hostSession = identity.hostStartupSessionId ?? process.env.MIZAR_STARTUP_SESSION_ID;
    this.hostStartupSessionId =
      typeof hostSession === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(hostSession)
        ? hostSession
        : null;
    const appVersion = identity.appVersion ?? process.env.MIZAR_APP_VERSION;
    this.identity = {
      appVersion:
        typeof appVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(appVersion)
          ? appVersion
          : null,
      gitSha:
        typeof identity.gitSha === 'string' && /^[a-f0-9]{40}$/i.test(identity.gitSha)
          ? identity.gitSha
          : null,
      artifactSha256:
        typeof identity.artifactSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(identity.artifactSha256)
          ? identity.artifactSha256
          : null,
    };
    this.record('session_start', {
      limits: SESSION_LIMITS,
      durability: 'async; abrupt power loss may lose pending or OS-buffered records',
    });
  }
  record(stage: string, evidence: unknown): void {
    if (this.closed) {
      this.rejectedAfterClose++;
      return;
    }
    try {
      this.enqueue(stage, evidence);
    } catch {
      this.failures++;
    }
  }
  /** Explicit marker acknowledgment; ordinary ingress records remain asynchronous. */
  recordCommitted(stage: string, evidence: unknown): Promise<number> {
    if (this.closed) {
      this.rejectedAfterClose++;
      return Promise.reject(new Error('session_journal_closed'));
    }
    return new Promise((resolve, reject) => {
      try {
        this.enqueue(stage, evidence, { resolve, reject });
      } catch (error) {
        this.failures++;
        reject(
          error instanceof Error
            ? error
            : new Error('session_journal_record_failed', { cause: error }),
        );
      }
    });
  }
  private enqueue(
    stage: string,
    evidence: unknown,
    receipt?: { resolve: (sequence: number) => void; reject: (error: unknown) => void },
  ): void {
    const line =
      JSON.stringify({
        time: new Date().toISOString(),
        startupSessionId: this.sessionId,
        hostStartupSessionId: this.hostStartupSessionId,
        ...this.identity,
        sequence: ++this.sequence,
        stage,
        taskId: null,
        trigger: 'system',
        ...this.requestContext.getStore(),
        droppedBefore: this.dropped,
        writeFailuresBefore: this.failures,
        evidence: diagnosticValue(evidence),
      }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > SESSION_LIMITS.pendingBytes) {
      this.dropped++;
      receipt?.reject(new Error('session_journal_pending_budget'));
      return;
    }
    this.pendingBytes += bytes;
    this.pending.push({ line, bytes, sequence: this.sequence, ...(receipt ? { receipt } : {}) });
    if (receipt && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.draining && !this.retryTimer) this.startWriter();
  }
  private startWriter() {
    if (this.draining) return;
    this.draining = true;
    this.writer = Promise.resolve().then(() => this.drain());
  }
  private async drain(): Promise<void> {
    let failed = false;
    try {
      while (this.pending.length) {
        const batch = [];
        let bytes = 0;
        do {
          const entry = this.pending.shift()!;
          batch.push(entry);
          bytes += entry.bytes;
        } while (this.pending.length && bytes + this.pending[0]!.bytes <= 256 * 1024);
        this.inflightRecords = batch.length;
        this.inflightLines = batch.map((entry) => entry.line);
        try {
          await this.append(
            batch.map((entry) => entry.line).join(''),
            bytes,
            batch.some((entry) => entry.receipt),
          );
          this.writeError = null;
          this.pendingBytes -= bytes;
          for (const entry of batch) entry.receipt?.resolve(entry.sequence);
          for (const { line } of batch)
            for (const listener of this.listeners) {
              try {
                listener(line);
              } catch {
                /* Delivery cannot alter local diagnostics. */
              }
            }
        } catch (error) {
          this.failures++;
          this.writeError = diagnosticValue(error);
          const retained = [];
          for (const entry of batch) {
            if (entry.receipt) {
              // A rejected explicit acknowledgment remains failed. Its owner
              // (window spool/native cursor) decides whether to retry it.
              entry.receipt.reject(error);
              this.pendingBytes -= entry.bytes;
            } else retained.push(entry);
          }
          this.pending.unshift(...retained);
          failed = true;
          break;
        } finally {
          this.inflightRecords = 0;
          this.inflightLines = [];
        }
      }
    } finally {
      this.draining = false;
      if (failed && this.pending.length && !this.closed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.startWriter();
        }, 1000);
        this.retryTimer.unref();
      }
    }
  }
  /** Windows append-only handles cannot truncate. Open a separate writable
   * handle only for rollback, and prove it is the same owned producer inode. */
  private async rollbackAppend(
    path: string,
    identity: { ino: number; dev: number },
    offset: number,
  ) {
    await safePath(this.directory);
    const file = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await safePath(this.directory);
      const named = await lstat(path);
      const actual = await file.stat();
      if (
        !actual.isFile() ||
        actual.nlink !== 1 ||
        named.isSymbolicLink() ||
        actual.ino !== identity.ino ||
        actual.dev !== identity.dev ||
        named.ino !== actual.ino ||
        named.dev !== actual.dev
      )
        throw new Error('session_rollback_file_changed');
      await file.truncate(offset);
    } finally {
      await file.close();
    }
  }
  private async append(line: string, bytes: number, sync = false) {
    await this.initialize();
    if (this.size + bytes > SESSION_LIMITS.segmentBytes) await this.rotate();
    await safePath(this.directory);
    const path = join(this.directory, 'session.ndjson');
    const before = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
      throw new Error('unsafe_session_log');
    const fd = await open(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await safePath(this.directory);
      const named = await lstat(path);
      const opened = await fd.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        named.isSymbolicLink() ||
        named.ino !== opened.ino ||
        named.dev !== opened.dev ||
        (before && (before.ino !== opened.ino || before.dev !== opened.dev))
      )
        throw new Error('session_log_changed');
      let appendStart = opened.size;
      if (this.repair) {
        if (this.repair.ino === opened.ino && this.repair.dev === opened.dev) {
          await this.rollbackAppend(path, opened, this.repair.offset);
          appendStart = this.repair.offset;
        }
        this.repair = undefined;
      }
      try {
        await fd.writeFile(line);
        if (sync) await fd.sync();
        this.size = appendStart + bytes;
      } catch (error) {
        try {
          await this.rollbackAppend(path, opened, appendStart);
          this.size = appendStart;
        } catch (rollback) {
          this.repair = { ino: opened.ino, dev: opened.dev, offset: appendStart };
          throw new AggregateError([error, rollback], 'session_append_rollback_failed', {
            cause: rollback,
          });
        }
        throw error;
      }
    } finally {
      await fd.close();
    }
  }

  write(line: string): void {
    try {
      this.record('service_log', JSON.parse(line));
    } catch {
      this.record('service_log', { text: line });
    }
  }
  private async initialize() {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true });
    await safePath(this.directory);
    try {
      const path = await safePath(this.directory, 'session-retention.json');
      const stat = await lstat(path);
      if (stat.size > 4096) throw new Error('invalid_retention_metadata');
      const value = JSON.parse(await readFile(path, 'utf8')) as typeof this.retention;
      for (const key of Object.keys(this.retention) as (keyof typeof this.retention)[])
        if (Number.isSafeInteger(value[key]) && value[key] >= 0) this.retention[key] = value[key];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failures++;
    }
    for (let index = 0; index < SESSION_LIMITS.segments; index++) {
      const path = join(this.directory, index ? `session.ndjson.${index}` : 'session.ndjson');
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error('unsafe_session_log');
        if (Date.now() - stat.mtimeMs > SESSION_LIMITS.retentionDays * 86400_000) {
          await unlink(path);
          this.retention.expiredFiles++;
          this.retention.expiredBytes += stat.size;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.size = await lstat(join(this.directory, 'session.ndjson')).then(
      (s) => s.size,
      () => 0,
    );
    await atomicJson(join(this.directory, 'session-retention.json'), this.retention);
    this.initialized = true;
  }
  private async rotate() {
    const oldest = await lstat(
      join(this.directory, `session.ndjson.${SESSION_LIMITS.segments - 1}`),
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (oldest) {
      this.retention.rotatedFiles++;
      this.retention.rotatedBytes += oldest.size;
    }
    await atomicJson(join(this.directory, 'session-retention.json'), this.retention);
    await unlink(join(this.directory, `session.ndjson.${SESSION_LIMITS.segments - 1}`)).catch(
      (e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      },
    );
    for (let index = SESSION_LIMITS.segments - 2; index >= 0; index--) {
      await rename(
        join(this.directory, index ? `session.ndjson.${index}` : 'session.ndjson'),
        join(this.directory, `session.ndjson.${index + 1}`),
      ).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      });
    }
    this.size = 0;
  }
  async flush() {
    await this.writer;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.pending.length && !this.draining) this.startWriter();
    await this.writer;
  }
  health() {
    return {
      sessionId: this.sessionId,
      sequence: this.sequence,
      dropped: this.dropped,
      writeFailures: this.failures,
      writeError: this.writeError,
      pendingRecords: this.pending.length + this.inflightRecords,
      pendingBytes: this.pendingBytes,
      closed: this.closed,
      rejectedAfterClose: this.rejectedAfterClose,
      retention: this.retention,
    };
  }
  pendingEvidence(): readonly string[] {
    return [...this.inflightLines, ...this.pending.map((entry) => entry.line)];
  }
  close() {
    if (!this.closing) {
      this.record('session_end', this.health());
      this.closed = true;
      this.closing = this.flush();
    }
    return this.closing;
  }
}
