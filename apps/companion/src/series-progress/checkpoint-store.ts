import { readFileSync } from 'node:fs';
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

/** Small, single-file checkpoint store for the Companion-owned SeriesProgress. */
export class JsonSeriesProgressCheckpointStore implements SeriesProgressCheckpointStore {
  private readonly filePath: string;
  private readonly onDiagnostic: SeriesProgressCheckpointStoreOptions['onDiagnostic'];
  private readonly commitQueue = new SerialCommitQueue();
  private lastWriteFailure: unknown;
  private writeFailed = false;

  constructor(options: SeriesProgressCheckpointStoreOptions) {
    this.filePath = options.filePath;
    this.onDiagnostic = options.onDiagnostic;
  }

  load(): SeriesProgressCheckpoint | undefined {
    let contents: string;
    try {
      contents = readFileSync(this.filePath, 'utf8');
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
    return this.commitQueue.run(async () => {
      try {
        const previous = this.load();
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
        await replaceDurableJson(this.filePath, checkpoint);
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
    if (this.writeFailed)
      throw this.lastWriteFailure ?? new Error('series_checkpoint_write_failed');
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
