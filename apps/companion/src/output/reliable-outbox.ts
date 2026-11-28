import { parseReliableEventV2, type ReliableEventV2 } from '@mizar/protocol/output';
import { RELIABLE_OUTBOX_RETENTION_MS, type ReliableOutboxRecord } from './outbox-codec.js';
import { OutboxRepository } from './outbox-repository.js';
import {
  RELIABLE_SEND_TIMEOUT_MS,
  type ReliableDeliveryResult,
  type ReliableEventSink,
} from './reliable-delivery.js';

export * from './outbox-codec.js';
export * from './reliable-delivery.js';

const BASE_RETRY_BACKOFF_MS = 1_000;
const MAX_RETRY_BACKOFF_MS = 60_000;
const MAP_ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function outboxLocalError(error: unknown): { name?: string; code?: string } {
  if (!(error instanceof Error)) return {};
  const code = (error as NodeJS.ErrnoException).code;
  return { name: error.name, ...(typeof code === 'string' ? { code } : {}) };
}

export class ReliableOutbox {
  private repo: OutboxRepository | undefined;
  private loading: Promise<void> | undefined;
  private flushing: Promise<void> | undefined;
  private closeAbort = new AbortController();
  private closed = false;

  constructor(
    private readonly filePath: string,
    private readonly onDiagnostic?: (code: string, detail?: string) => void,
    private readonly onJournal?: (record: ReliableOutboxRecord, reason: string) => void,
  ) {}

  async load(): Promise<void> {
    if (this.closed) return;
    if (this.repo) return;
    this.loading ??= OutboxRepository.open(`${this.filePath}.sqlite`).then((repo) => {
      this.repo = repo;
    });
    await this.loading;
  }

  isReady(): boolean {
    return this.repo !== undefined && !this.closed;
  }

  enqueue(event: ReliableEventV2, now = new Date()): boolean {
    if (!this.repo || this.closed) return false;
    const valid = parseReliableEventV2(event);
    const nowIso = now.toISOString();
    const inserted = this.repo.insert(valid, nowIso);
    if (inserted) {
      this.onJournal?.(
        {
          event: valid,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastError: null,
        },
        'queued',
      );
    }
    return inserted;
  }

  async flush(sink: ReliableEventSink, now = new Date()): Promise<void> {
    if (!this.repo || this.closed) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.runFlush(sink, now).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async runFlush(sink: ReliableEventSink, now: Date): Promise<void> {
    const repo = this.repo;
    if (!repo || this.closed) return;
    const due = repo.listDuePending(now.toISOString());
    for (const record of due) {
      if (this.closed || this.closeAbort.signal.aborted) break;
      const nowMs = now.getTime();
      const nowIso = new Date(nowMs).toISOString();
      const retentionMs =
        record.event.kind === 'map_ended' ? MAP_ENDED_RETENTION_MS : RELIABLE_OUTBOX_RETENTION_MS;
      if (nowMs - Date.parse(record.createdAt) >= retentionMs) {
        repo.markExpired(record.event.idempotencyKey, nowIso);
        this.onJournal?.({ ...record, status: 'expired', updatedAt: nowIso }, 'expired');
        continue;
      }
      let result: ReliableDeliveryResult;
      try {
        const signal = AbortSignal.any([
          this.closeAbort.signal,
          AbortSignal.timeout(RELIABLE_SEND_TIMEOUT_MS),
        ]);
        result = await sink.send(record.event, signal);
      } catch (error) {
        result = {
          status: 'retry',
          error: error instanceof Error ? error.message : 'send_failed',
        };
      }
      if (this.closed || this.closeAbort.signal.aborted) break;
      const doneIso = nowIso;
      if (result.status === 'accepted') {
        const note =
          result.warning ?? (result.outcome === 'needs_attention' ? 'needs_attention' : undefined);
        repo.markAccepted(record.event.idempotencyKey, doneIso, note);
        if (note) this.onDiagnostic?.('reliable_needs_attention', note);
        this.onJournal?.(
          {
            ...record,
            status: 'accepted',
            attempts: record.attempts + 1,
            updatedAt: doneIso,
            lastError: note ?? null,
          },
          'accepted',
        );
      } else if (result.status === 'rejected') {
        repo.markRejected(record.event.idempotencyKey, doneIso, result.error);
        this.onDiagnostic?.('reliable_rejected', result.error);
        this.onJournal?.(
          {
            ...record,
            status: 'rejected',
            attempts: record.attempts + 1,
            updatedAt: doneIso,
            lastError: result.error,
          },
          'rejected',
        );
      } else {
        const nextAttempts = record.attempts + 1;
        const backoffMs = Math.min(
          MAX_RETRY_BACKOFF_MS,
          BASE_RETRY_BACKOFF_MS * 2 ** Math.min(record.attempts, 6),
        );
        const nextAttemptAt = new Date(nowMs + backoffMs).toISOString();
        repo.markRetry(
          record.event.idempotencyKey,
          nextAttempts,
          nextAttemptAt,
          doneIso,
          result.error,
        );
      }
    }
  }

  records(limit = 100): readonly ReliableOutboxRecord[] {
    if (!this.repo || this.closed) return [];
    return this.repo.listRecent(limit);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeAbort.abort();
    await Promise.allSettled([this.loading, this.flushing]);
    this.repo?.close();
    this.repo = undefined;
  }
}
