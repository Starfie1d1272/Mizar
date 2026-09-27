import { readFileSync } from 'node:fs';

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
  ) => void;
}

/** Small, single-file checkpoint store for the Companion-owned SeriesProgress. */
export class JsonSeriesProgressCheckpointStore implements SeriesProgressCheckpointStore {
  private readonly filePath: string;
  private readonly onDiagnostic: SeriesProgressCheckpointStoreOptions['onDiagnostic'];
  private readonly commitQueue = new SerialCommitQueue();

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
      this.onDiagnostic?.('checkpoint_read_failed');
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      this.onDiagnostic?.('checkpoint_invalid');
      return undefined;
    }
    if (!isSeriesProgressCheckpoint(parsed)) {
      this.onDiagnostic?.('checkpoint_invalid');
      return undefined;
    }
    return parsed;
  }

  save(checkpoint: SeriesProgressCheckpoint): Promise<void> {
    return this.commitQueue.run(async () => {
      try {
        await replaceDurableJson(this.filePath, checkpoint);
      } catch {
        this.onDiagnostic?.('checkpoint_write_failed');
      }
    });
  }

  async flush(): Promise<void> {
    await this.commitQueue.flush();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
