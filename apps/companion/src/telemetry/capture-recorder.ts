import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  createCaptureManifest,
  openCaptureFile,
  renameCapture,
  serializeCaptureFrame,
  writeCaptureManifest,
  writeFully,
  type CaptureFileHandle,
  type CaptureFrameInput,
  type ObjectiveReferenceInput,
  type CaptureWriterFactory,
} from './capture-storage.js';

export type {
  CaptureFileHandle,
  CaptureFrameInput,
  CaptureWriterFactory,
  ProductionCaptureFrameV1,
  ProductionCaptureManifestV1,
  ObjectiveReferenceInput,
} from './capture-storage.js';

export const RECORDER_MAX_PENDING_FRAMES = 128;
export const RECORDER_MAX_PENDING_BYTES = 2 * 1024 * 1024;
export const RECORDER_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

export type RecorderState = 'recording' | 'degraded' | 'failed' | 'finalizing' | 'closed';

export type RecorderErrorCode =
  | 'recorder_not_configured'
  | 'recorder_start_failed'
  | 'recorder_encode_failed'
  | 'recorder_overflow'
  | 'recorder_writer_failed'
  | 'recorder_finalize_timeout'
  | 'recorder_finalize_failed';

export type RecorderOperation =
  'open' | 'encode' | 'write' | 'truncate' | 'sync' | 'close' | 'manifest' | 'rename';

export interface RecorderHealth {
  readonly state: RecorderState;
  readonly pendingFrames: number;
  readonly pendingBytes: number;
  readonly maxPendingFrames: number;
  readonly maxPendingBytes: number;
  readonly frameCount: number;
  readonly droppedFrames: number;
  readonly incomplete: boolean;
  readonly lastErrorCode?: RecorderErrorCode;
}

export interface RecorderDiagnostic {
  readonly code: RecorderErrorCode;
  readonly operation?: RecorderOperation;
  readonly causeCode?: string;
}

export interface CaptureRecorder {
  readonly captureId: string;
  tryRecord(input: CaptureFrameInput): boolean;
  tryRecordObjectiveReference?(input: ObjectiveReferenceInput): boolean;
  captureElapsedUsAt?(monotonicMs: number): number | undefined;
  getHealth(): RecorderHealth;
  finalize(): Promise<void>;
  assertDurableFinalized?(): void;
}

export type CaptureRecorderSource = CaptureRecorder | (() => CaptureRecorder);

export function resolveCaptureRecorder(source: CaptureRecorderSource): CaptureRecorder {
  return typeof source === 'function' ? source() : source;
}

export interface CaptureRecorderOptions {
  readonly captureDir: string;
  readonly broadcastCommit?: string;
  readonly gsiConfig: Record<string, unknown>;
  readonly captureId?: string;
  readonly createdAt?: string;
  readonly windowsVersion?: string;
  readonly cs2Build?: string;
  readonly artifactSha256?: string;
  readonly qualificationRunId?: string;
  readonly monotonicNow?: () => number;
  readonly wallClockNow?: () => string;
  readonly writerFactory?: CaptureWriterFactory;
  readonly shutdownDrainTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: RecorderDiagnostic) => void;
}

type RecorderLifecycle = 'accepting' | 'finalizing' | 'abandoned' | 'closed';
type RecorderWriterState = 'healthy' | 'failed';
type RecorderIntegrity = 'complete-candidate' | 'incomplete';

function defaultCaptureId(createdAt: string): string {
  const timestamp = createdAt.replace(/[-:.TZ]/g, '');
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function getCauseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : undefined;
}

class ProductionCaptureRecorder implements CaptureRecorder {
  readonly captureId: string;

  private readonly captureDir: string;
  private readonly partialDir: string;
  private readonly finalDir: string;
  private readonly framesPath: string;
  private readonly createdAt: string;
  private readonly broadcastCommit: string;
  private readonly gsiConfig: Record<string, unknown>;
  private readonly windowsVersion: string | undefined;
  private readonly cs2Build: string | undefined;
  private readonly artifactSha256: string | undefined;
  private readonly qualificationRunId: string | undefined;
  private readonly startedMonotonicMs: number;
  private readonly writerFactory: CaptureWriterFactory;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly onDiagnostic: ((diagnostic: RecorderDiagnostic) => void) | undefined;
  private readonly objectiveReferencesPath: string;
  private objectiveReferenceWriteChain: Promise<void> = Promise.resolve();
  private objectiveReferenceWriteFailed = false;
  private durableFailure = false;
  private readonly hash = createHash('sha256');
  private readonly queue: Buffer[] = [];
  private readonly emittedDiagnostics = new Set<RecorderErrorCode>();

  private fileHandle: CaptureFileHandle | undefined;
  private activeBuffer: Buffer | undefined;
  private pumpPromise: Promise<void> | undefined;
  private lifecycle: RecorderLifecycle = 'accepting';
  private writerState: RecorderWriterState = 'healthy';
  private integrity: RecorderIntegrity = 'complete-candidate';
  private finalizePromise: Promise<void> | undefined;
  private pendingFrames = 0;
  private pendingBytes = 0;
  private frameCount = 0;
  private droppedFrames = 0;
  private confirmedOffset = 0;
  private lastElapsedUs = 0;
  private lastErrorCode: RecorderErrorCode | undefined;
  private publicationSafe = true;

  private constructor(options: CaptureRecorderOptions) {
    this.captureDir = options.captureDir;
    this.createdAt = options.createdAt ?? options.wallClockNow?.() ?? new Date().toISOString();
    this.captureId = options.captureId ?? defaultCaptureId(this.createdAt);
    this.partialDir = join(this.captureDir, `${this.captureId}.partial`);
    this.finalDir = join(this.captureDir, this.captureId);
    this.framesPath = join(this.partialDir, 'frames.jsonl');
    this.objectiveReferencesPath = join(this.partialDir, 'objective-events.jsonl');
    this.broadcastCommit = options.broadcastCommit ?? 'unknown';
    this.windowsVersion = options.windowsVersion;
    this.cs2Build = options.cs2Build;
    this.artifactSha256 = options.artifactSha256;
    this.qualificationRunId = options.qualificationRunId;
    this.gsiConfig = { ...options.gsiConfig };
    delete this.gsiConfig.auth;
    delete this.gsiConfig.token;
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.startedMonotonicMs = monotonicNow();
    this.writerFactory = options.writerFactory ?? openCaptureFile;
    this.shutdownDrainTimeoutMs =
      options.shutdownDrainTimeoutMs ?? RECORDER_SHUTDOWN_DRAIN_TIMEOUT_MS;
    this.onDiagnostic = options.onDiagnostic;
  }

  static async create(options: CaptureRecorderOptions): Promise<ProductionCaptureRecorder> {
    const recorder = new ProductionCaptureRecorder(options);
    try {
      await mkdir(recorder.captureDir, { recursive: true, mode: 0o700 });
      await mkdir(recorder.partialDir, { mode: 0o700 });
      recorder.fileHandle = await recorder.writerFactory(recorder.framesPath);
    } catch (error: unknown) {
      const causeCode = getCauseCode(error);
      try {
        options.onDiagnostic?.({
          code: 'recorder_start_failed',
          operation: 'open',
          ...(causeCode === undefined ? {} : { causeCode }),
        });
      } catch {
        // Startup diagnostics must not replace the original startup error.
      }
      throw error;
    }
    return recorder;
  }

  tryRecord(input: CaptureFrameInput): boolean {
    if (
      this.lifecycle !== 'accepting' ||
      this.writerState === 'failed' ||
      this.fileHandle === undefined
    ) {
      this.dropFrame();
      return false;
    }

    if (this.pendingFrames + 1 > RECORDER_MAX_PENDING_FRAMES) {
      this.dropFrame('recorder_overflow', 'write');
      return false;
    }

    let buffer: Buffer;
    try {
      buffer = serializeCaptureFrame(input, this.elapsedUs(input.receivedMonotonicMs));
    } catch (error: unknown) {
      this.droppedFrames += 1;
      this.markIncomplete();
      this.recordError('recorder_encode_failed', 'encode', error);
      return false;
    }

    if (this.pendingBytes + buffer.byteLength > RECORDER_MAX_PENDING_BYTES) {
      this.dropFrame('recorder_overflow', 'write');
      return false;
    }

    this.queue.push(buffer);
    this.pendingFrames += 1;
    this.pendingBytes += buffer.byteLength;
    this.ensurePump();
    return true;
  }

  tryRecordObjectiveReference(input: ObjectiveReferenceInput): boolean {
    if (
      this.lifecycle !== 'accepting' ||
      this.writerState === 'failed' ||
      this.objectiveReferenceWriteFailed
    )
      return false;
    const occurredAtUs = this.captureElapsedUsAt(input.occurredMonotonicMs);
    if (occurredAtUs === undefined) return false;
    const reference = {
      version: 2,
      referenceId: input.referenceId,
      kind: input.kind,
      source: input.source,
      captureId: this.captureId,
      timebase: 'capture-elapsed-us',
      occurredAtUs,
      sourceCursor: input.sourceCursor,
      sourceArtifact: input.sourceArtifact,
      ...(input.hasKit === undefined ? {} : { hasKit: input.hasKit }),
    };
    const line = `${JSON.stringify(reference)}\n`;
    this.objectiveReferenceWriteChain = this.objectiveReferenceWriteChain.then(async () => {
      try {
        await appendFile(this.objectiveReferencesPath, line, { encoding: 'utf8', mode: 0o600 });
      } catch (error: unknown) {
        this.objectiveReferenceWriteFailed = true;
        this.markIncomplete();
        this.recordError('recorder_writer_failed', 'write', error);
      }
    });
    return true;
  }

  captureElapsedUsAt(monotonicMs: number): number | undefined {
    const elapsedDelta = (monotonicMs - this.startedMonotonicMs) * 1000;
    if (!Number.isFinite(elapsedDelta) || elapsedDelta < 0) return undefined;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(elapsedDelta));
  }

  getHealth(): RecorderHealth {
    let state: RecorderState;
    if (this.lifecycle === 'closed') {
      state = 'closed';
    } else if (this.lifecycle === 'abandoned') {
      state = 'failed';
    } else if (this.lifecycle === 'finalizing') {
      state = 'finalizing';
    } else if (this.writerState === 'failed') {
      state = 'failed';
    } else if (this.integrity === 'incomplete') {
      state = 'degraded';
    } else {
      state = 'recording';
    }

    return {
      state,
      pendingFrames: this.pendingFrames,
      pendingBytes: this.pendingBytes,
      maxPendingFrames: RECORDER_MAX_PENDING_FRAMES,
      maxPendingBytes: RECORDER_MAX_PENDING_BYTES,
      frameCount: this.frameCount,
      droppedFrames: this.droppedFrames,
      incomplete: this.integrity === 'incomplete',
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
    };
  }

  finalize(): Promise<void> {
    this.finalizePromise ??= this.finalizeInternal();
    return this.finalizePromise;
  }

  assertDurableFinalized(): void {
    if (this.lifecycle !== 'closed' || this.durableFailure)
      throw new Error('capture_durable_finalize_failed');
  }

  private elapsedUs(receivedMonotonicMs: number): number {
    const elapsedDelta = (receivedMonotonicMs - this.startedMonotonicMs) * 1000;
    const candidateElapsedUs = Number.isFinite(elapsedDelta)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(elapsedDelta)))
      : this.lastElapsedUs;
    const elapsedUs = Math.max(this.lastElapsedUs, candidateElapsedUs);
    this.lastElapsedUs = elapsedUs;
    return elapsedUs;
  }

  private ensurePump(): void {
    if (this.pumpPromise !== undefined) return;

    const pumpPromise = this.runPump().catch((error: unknown) => {
      this.handleWriterFailure(error);
    });
    this.pumpPromise = pumpPromise;
    void pumpPromise.then(() => {
      if (this.pumpPromise !== pumpPromise) return;
      this.pumpPromise = undefined;
      if (
        this.lifecycle === 'accepting' &&
        this.writerState === 'healthy' &&
        this.queue.length > 0
      ) {
        this.ensurePump();
      }
    });
  }

  private async runPump(): Promise<void> {
    try {
      while (
        this.queue.length > 0 &&
        this.writerState === 'healthy' &&
        this.lifecycle !== 'abandoned'
      ) {
        const buffer = this.queue.shift();
        if (buffer === undefined) break;
        this.activeBuffer = buffer;

        try {
          if (this.fileHandle === undefined) throw new Error('capture file is not open');
          await writeFully(this.fileHandle, buffer, this.confirmedOffset);
        } catch (error: unknown) {
          this.handleWriterFailure(error);
          break;
        }

        this.frameCount += 1;
        this.confirmedOffset += buffer.byteLength;
        this.hash.update(buffer);
        this.pendingFrames -= 1;
        this.pendingBytes -= buffer.byteLength;
        this.activeBuffer = undefined;
      }
    } finally {
      if (this.lifecycle === 'abandoned' && this.activeBuffer === undefined) {
        await this.closeAbandonedFile();
      }
    }
  }

  private handleWriterFailure(error: unknown): void {
    if (this.writerState === 'failed') return;
    this.writerState = 'failed';
    this.markIncomplete();
    this.recordError('recorder_writer_failed', 'write', error);

    this.droppedFrames += (this.activeBuffer === undefined ? 0 : 1) + this.queue.length;
    this.queue.length = 0;
    this.pendingFrames = 0;
    this.pendingBytes = 0;
    this.activeBuffer = undefined;
  }

  private dropFrame(code?: RecorderErrorCode, operation?: RecorderOperation): void {
    this.droppedFrames += 1;
    this.markIncomplete();
    if (code !== undefined) this.recordError(code, operation);
  }

  private markIncomplete(): void {
    this.integrity = 'incomplete';
  }

  private recordError(
    code: RecorderErrorCode,
    operation?: RecorderOperation,
    error?: unknown,
  ): void {
    this.lastErrorCode = code;
    if (
      ['recorder_writer_failed', 'recorder_finalize_timeout', 'recorder_finalize_failed'].includes(
        code,
      )
    )
      this.durableFailure = true;
    const causeCode = getCauseCode(error);
    this.emitDiagnostic({
      code,
      ...(operation === undefined ? {} : { operation }),
      ...(causeCode === undefined ? {} : { causeCode }),
    });
  }

  private emitDiagnostic(diagnostic: RecorderDiagnostic): void {
    if (this.emittedDiagnostics.has(diagnostic.code)) return;
    this.emittedDiagnostics.add(diagnostic.code);
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never affect the live telemetry path.
    }
  }

  private discardQueuedFrames(): void {
    if (this.queue.length > 0) {
      this.droppedFrames += this.queue.length;
      this.markIncomplete();
      this.queue.length = 0;
    }
    this.pendingFrames = this.activeBuffer === undefined ? 0 : 1;
    this.pendingBytes = this.activeBuffer?.byteLength ?? 0;
  }

  private async waitForPump(pumpPromise: Promise<void> | undefined): Promise<boolean> {
    if (pumpPromise === undefined) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        settled = true;
        resolve(true);
      }, this.shutdownDrainTimeoutMs);
      void pumpPromise.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(false);
      });
    });
  }

  private async closeAbandonedFile(): Promise<void> {
    if (this.fileHandle === undefined) return;
    const fileHandle = this.fileHandle;
    this.fileHandle = undefined;
    try {
      await fileHandle.truncate(this.confirmedOffset);
    } catch (error: unknown) {
      this.publicationSafe = false;
      this.recordError('recorder_finalize_failed', 'truncate', error);
    }
    try {
      await fileHandle.close();
    } catch (error: unknown) {
      this.publicationSafe = false;
      this.recordError('recorder_finalize_failed', 'close', error);
    }
    if (!this.publicationSafe) this.markIncomplete();
    this.lifecycle = 'closed';
  }

  private async finalizeInternal(): Promise<void> {
    if (this.lifecycle === 'closed') return;
    this.lifecycle = 'finalizing';
    await this.objectiveReferenceWriteChain;
    if (this.fileHandle === undefined) {
      this.lifecycle = 'closed';
      return;
    }

    const pumpPromise = this.pumpPromise;
    const timedOut = await this.waitForPump(pumpPromise);
    if (timedOut) {
      this.markIncomplete();
      this.recordError('recorder_finalize_timeout');
      this.discardQueuedFrames();
      if (this.activeBuffer !== undefined || this.pumpPromise !== undefined) {
        this.lifecycle = 'abandoned';
        return;
      }
    }

    if (this.activeBuffer !== undefined || this.pumpPromise !== undefined) {
      this.lifecycle = 'abandoned';
      return;
    }

    const fileHandle = this.fileHandle;
    if (fileHandle === undefined) {
      this.lifecycle = 'closed';
      return;
    }

    let safe = this.publicationSafe;
    try {
      await fileHandle.truncate(this.confirmedOffset);
    } catch (error: unknown) {
      safe = false;
      this.publicationSafe = false;
      this.recordError('recorder_finalize_failed', 'truncate', error);
    }
    try {
      await fileHandle.sync();
    } catch (error: unknown) {
      safe = false;
      this.publicationSafe = false;
      this.recordError('recorder_finalize_failed', 'sync', error);
    }
    try {
      await fileHandle.close();
    } catch (error: unknown) {
      safe = false;
      this.publicationSafe = false;
      this.recordError('recorder_finalize_failed', 'close', error);
    }
    this.fileHandle = undefined;

    if (!safe) {
      this.markIncomplete();
      this.lifecycle = 'closed';
      return;
    }

    const framesSha256 = this.hash.digest('hex');
    const manifest = createCaptureManifest(
      this.captureId,
      this.createdAt,
      this.broadcastCommit,
      this.gsiConfig,
      this.integrity === 'complete-candidate' && this.droppedFrames === 0,
      this.frameCount,
      this.droppedFrames,
      framesSha256,
      {
        ...(this.windowsVersion === undefined ? {} : { windowsVersion: this.windowsVersion }),
        ...(this.cs2Build === undefined ? {} : { cs2Build: this.cs2Build }),
        ...(this.artifactSha256 === undefined ? {} : { artifactSha256: this.artifactSha256 }),
        ...(this.qualificationRunId === undefined
          ? {}
          : { qualificationRunId: this.qualificationRunId }),
        monotonicOriginMs: this.startedMonotonicMs,
      },
    );

    try {
      await writeCaptureManifest(this.partialDir, manifest);
    } catch (error: unknown) {
      this.markIncomplete();
      this.recordError('recorder_finalize_failed', 'manifest', error);
      this.lifecycle = 'closed';
      return;
    }
    try {
      await renameCapture(this.partialDir, this.finalDir);
    } catch (error: unknown) {
      this.markIncomplete();
      this.recordError('recorder_finalize_failed', 'rename', error);
      this.lifecycle = 'closed';
      return;
    }
    this.lifecycle = 'closed';
  }
}

class DisabledCaptureRecorder implements CaptureRecorder {
  readonly captureId = 'disabled';

  private droppedFrames = 0;
  private closed = false;

  constructor(private readonly lastErrorCode: RecorderErrorCode) {}

  tryRecord(): boolean {
    this.droppedFrames += 1;
    return false;
  }

  getHealth(): RecorderHealth {
    return {
      state: this.closed ? 'closed' : 'degraded',
      pendingFrames: 0,
      pendingBytes: 0,
      maxPendingFrames: RECORDER_MAX_PENDING_FRAMES,
      maxPendingBytes: RECORDER_MAX_PENDING_BYTES,
      frameCount: 0,
      droppedFrames: this.droppedFrames,
      incomplete: true,
      lastErrorCode: this.lastErrorCode,
    };
  }

  finalize(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export async function createCaptureRecorder(
  options: CaptureRecorderOptions,
): Promise<CaptureRecorder> {
  return ProductionCaptureRecorder.create(options);
}

export function createDisabledRecorder(
  lastErrorCode: RecorderErrorCode = 'recorder_start_failed',
): CaptureRecorder {
  return new DisabledCaptureRecorder(lastErrorCode);
}
