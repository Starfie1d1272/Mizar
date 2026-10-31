import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';

import {
  isSeriesProgressCheckpoint,
  type SeriesProgressCheckpoint,
  type SeriesProgressCheckpointStore,
} from '@mizar/core/series-progress';

import { replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';

export interface SeriesProgressCheckpointStoreOptions {
  readonly filePath: string;
  readonly onDiagnostic?: (
    code: 'checkpoint_invalid' | 'checkpoint_read_failed' | 'checkpoint_write_failed',
    error: unknown,
  ) => void;
}

/** Current checkpoint plus per-match/plan history, owned by Companion alone. */
export class JsonSeriesProgressCheckpointStore implements SeriesProgressCheckpointStore {
  private readonly filePath: string;
  private readonly onDiagnostic: SeriesProgressCheckpointStoreOptions['onDiagnostic'];
  private readonly commitQueue = new SerialCommitQueue();
  private lastWriteFailure: unknown;
  private writeFailed = false;
  private readonly pending = new Map<string, SeriesProgressCheckpoint>();

  private historyPath(identity: SeriesProgressCheckpoint['identity']): string {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          identity.matchId,
          identity.format,
          identity.entryAId,
          identity.entryBId,
          identity.mapPlanFingerprint,
        ]),
      )
      .digest('hex');
    return `${this.filePath}.history-${key}.json`;
  }

  constructor(options: SeriesProgressCheckpointStoreOptions) {
    this.filePath = options.filePath;
    this.onDiagnostic = options.onDiagnostic;
  }

  load(identity?: SeriesProgressCheckpoint['identity']): SeriesProgressCheckpoint | undefined {
    if (identity) {
      const path = this.historyPath(identity);
      const pending = this.pending.get(path);
      if (pending) return structuredClone(pending);
      const historical = this.read(path);
      if (historical) return historical;
    }
    return this.read(this.filePath);
  }

  private read(path: string): SeriesProgressCheckpoint | undefined {
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      this.onDiagnostic?.('checkpoint_read_failed', error);
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error: unknown) {
      this.onDiagnostic?.('checkpoint_invalid', error);
      return undefined;
    }
    if (!isSeriesProgressCheckpoint(parsed)) {
      this.onDiagnostic?.(
        'checkpoint_invalid',
        new Error('Series progress checkpoint schema mismatch'),
      );
      return undefined;
    }
    return parsed;
  }

  save(checkpoint: SeriesProgressCheckpoint): Promise<void> {
    checkpoint = structuredClone(checkpoint);
    const historyPath = this.historyPath(checkpoint.identity);
    this.pending.set(historyPath, checkpoint);
    return this.commitQueue.run(async () => {
      try {
        const previous = this.read(this.filePath);
        if (
          previous &&
          this.historyPath(previous.identity) !== historyPath &&
          !existsSync(this.historyPath(previous.identity))
        )
          await replaceDurableJson(this.historyPath(previous.identity), previous);
        if (
          previous &&
          previous.identity.matchId !== checkpoint.identity.matchId &&
          (previous.unverifiedProgress ||
            (!previous.executionOwner &&
              (previous.progress.currentMapOrder !== null ||
                previous.progress.maps.some(
                  (map) =>
                    map.executionMapEpoch !== null ||
                    map.status !== 'pending' ||
                    map.finalScore !== null ||
                    map.roundHistory.rounds.length > 0,
                ))))
        ) {
          const serialized = JSON.stringify(previous);
          const identity = createHash('sha256')
            .update(JSON.stringify([previous.identity.matchId, serialized]))
            .digest('hex');
          const archivePath = `${this.filePath}.unverified-${identity}.json`;
          let archived: string | undefined;
          try {
            archived = readFileSync(archivePath, 'utf8');
          } catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
          }
          if (archived === undefined) {
            const temporary = `${archivePath}.${randomUUID()}.tmp`;
            try {
              await writeFile(temporary, `${JSON.stringify(previous, null, 2)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
                flush: true,
              });
              try {
                // Unlike rename, link never replaces an existing evidence file.
                await link(temporary, archivePath);
              } catch (error) {
                if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
                archived = readFileSync(archivePath, 'utf8');
              }
            } finally {
              await unlink(temporary).catch(() => undefined);
            }
          }
          if (
            archived !== undefined &&
            JSON.stringify(JSON.parse(archived) as unknown) !== serialized
          )
            throw new Error('series_unverified_history_conflict');
        }
        // Commit historical facts before changing the current-selection checkpoint.
        await replaceDurableJson(historyPath, checkpoint);
        await replaceDurableJson(this.filePath, checkpoint);
        if (this.pending.get(historyPath) === checkpoint) this.pending.delete(historyPath);
        this.lastWriteFailure = undefined;
        this.writeFailed = false;
      } catch (error: unknown) {
        this.lastWriteFailure = error;
        this.writeFailed = true;
        this.onDiagnostic?.('checkpoint_write_failed', error);
      }
    });
  }

  async flush(): Promise<void> {
    await this.commitQueue.flush();
    // Retain and retry the original accepted facts after a transient disk failure.
    for (const checkpoint of [...this.pending.values()]) await this.save(checkpoint);
    if (this.writeFailed || this.pending.size)
      throw this.lastWriteFailure ?? new Error('series_checkpoint_write_failed');
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
