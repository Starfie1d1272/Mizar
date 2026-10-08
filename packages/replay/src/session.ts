export interface ReplaySessionCursor {
  readonly captureIndex: number;
  readonly sequence: number;
  readonly scheduledElapsedUs: number;
}

export interface ReplaySessionFrame {
  readonly cursor: ReplaySessionCursor;
}

export interface ReplaySessionEvent {
  readonly id: string;
  readonly kind: string;
  readonly captureIndex: number;
  readonly sequence: number;
  readonly scheduledElapsedUs: number;
  readonly label: string;
}

export interface ReplaySessionScheduler {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReplaySessionSource<Frame extends ReplaySessionFrame> {
  readonly frames: readonly Frame[];
  readonly events: readonly ReplaySessionEvent[];
  /** Seeking reconstructs the frame from a fresh production replay prefix. */
  rebuild(targetCaptureIndex: number, signal: AbortSignal): Frame | Promise<Frame>;
}

export interface ReplaySessionSnapshot<Frame extends ReplaySessionFrame> {
  readonly current: Frame | null;
  readonly currentIndex: number;
  readonly currentEventId: string | null;
  readonly presentationRevision: number;
  readonly isPlaying: boolean;
  readonly isSeeking: boolean;
  readonly error: string | null;
}

/**
 * Framework-neutral replay cursor and scheduler. It selects discrete capture frames;
 * presentation code may animate between them but cannot alter their gameplay state.
 */
export class ReplaySession<Frame extends ReplaySessionFrame> {
  private readonly listeners = new Set<() => void>();
  private readonly source: ReplaySessionSource<Frame>;
  private readonly scheduler: ReplaySessionScheduler;
  private snapshot: ReplaySessionSnapshot<Frame>;
  private timer: unknown;
  private generation = 0;
  private seekController: AbortController | undefined;
  private disposed = false;
  private playbackWallAnchorMs = 0;
  private playbackCaptureAnchorUs = 0;
  private speed = 1;

  constructor(source: ReplaySessionSource<Frame>, scheduler: ReplaySessionScheduler) {
    if (source.frames.length === 0) throw new RangeError('Replay session needs at least one frame');
    for (let index = 0; index < source.frames.length; index += 1) {
      const frame = source.frames[index];
      if (frame === undefined) throw new RangeError(`Replay frame ${index} is missing`);
      if (frame.cursor.captureIndex !== index) {
        throw new RangeError(`Replay frame cursor mismatch at captureIndex ${index}`);
      }
      if (
        index > 0 &&
        frame.cursor.scheduledElapsedUs < source.frames[index - 1]!.cursor.scheduledElapsedUs
      ) {
        throw new RangeError('Replay frame elapsed time must be non-decreasing');
      }
    }
    this.source = source;
    this.scheduler = scheduler;
    this.playbackCaptureAnchorUs = source.frames[0]!.cursor.scheduledElapsedUs;
    this.snapshot = {
      current: source.frames[0]!,
      currentIndex: 0,
      currentEventId: this.eventIdAt(0),
      presentationRevision: 0,
      isPlaying: false,
      isSeeking: false,
      error: null,
    };
  }

  getSnapshot = (): ReplaySessionSnapshot<Frame> => this.snapshot;

  /** Presentation clock for synchronized media; never changes discrete gameplay facts. */
  getPlaybackElapsedUs = (): number => {
    const elapsed = this.snapshot.isPlaying
      ? this.playbackCaptureAnchorUs +
        (this.scheduler.nowMs() - this.playbackWallAnchorMs) * 1000 * this.speed
      : this.playbackCaptureAnchorUs;
    return Math.min(
      this.source.frames[this.source.frames.length - 1]!.cursor.scheduledElapsedUs,
      Math.max(this.source.frames[0]!.cursor.scheduledElapsedUs, elapsed),
    );
  };

  getPlaybackSpeed = (): number => this.speed;

  subscribe = (listener: () => void): (() => void) => {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  play(speed = 1): void {
    this.assertActive();
    if (!Number.isFinite(speed) || speed <= 0)
      throw new RangeError('Replay speed must be positive');
    if (this.snapshot.currentIndex >= this.source.frames.length - 1 || this.snapshot.isPlaying)
      return;
    this.speed = speed;
    this.playbackWallAnchorMs = this.scheduler.nowMs();
    this.update({ isPlaying: true, error: null });
    this.scheduleNextFrame();
  }

  pause(): void {
    if (this.disposed || !this.snapshot.isPlaying) return;
    this.playbackCaptureAnchorUs = this.getPlaybackElapsedUs();
    this.cancelTimer();
    this.update({ isPlaying: false });
  }

  async restart(): Promise<void> {
    await this.seekCaptureIndex(0);
  }

  async seekCaptureIndex(targetCaptureIndex: number, eventId?: string): Promise<void> {
    this.assertActive();
    if (
      !Number.isSafeInteger(targetCaptureIndex) ||
      targetCaptureIndex < 0 ||
      targetCaptureIndex >= this.source.frames.length
    ) {
      throw new RangeError(`Replay captureIndex is out of range: ${targetCaptureIndex}`);
    }
    if (
      eventId !== undefined &&
      !this.source.events.some(
        (event) => event.id === eventId && event.captureIndex === targetCaptureIndex,
      )
    ) {
      throw new RangeError(`Replay event does not match captureIndex ${targetCaptureIndex}`);
    }
    const generation = ++this.generation;
    this.seekController?.abort();
    const controller = new AbortController();
    this.seekController = controller;
    this.playbackCaptureAnchorUs = this.getPlaybackElapsedUs();
    this.cancelTimer();
    this.update({ isPlaying: false, isSeeking: true, error: null });
    try {
      const frame = await this.source.rebuild(targetCaptureIndex, controller.signal);
      if (this.disposed || generation !== this.generation) return;
      if (frame.cursor.captureIndex !== targetCaptureIndex) {
        throw new Error('Replay prefix rebuild returned a mismatched capture cursor');
      }
      this.playbackCaptureAnchorUs = frame.cursor.scheduledElapsedUs;
      this.update({
        current: frame,
        currentIndex: targetCaptureIndex,
        currentEventId: eventId ?? this.eventIdAt(targetCaptureIndex),
        presentationRevision: this.snapshot.presentationRevision + 1,
        isSeeking: false,
      });
      this.seekController = undefined;
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return;
      this.update({
        isSeeking: false,
        error: error instanceof Error ? error.message : 'Replay seek failed',
      });
      this.seekController = undefined;
      throw error;
    }
  }

  async seekElapsedUs(targetElapsedUs: number): Promise<void> {
    this.assertActive();
    if (!Number.isFinite(targetElapsedUs))
      throw new RangeError('Replay elapsed time must be finite');
    const clamped = Math.max(0, targetElapsedUs);
    let target = 0;
    for (let index = 1; index < this.source.frames.length; index += 1) {
      if (this.source.frames[index]!.cursor.scheduledElapsedUs > clamped) break;
      target = index;
    }
    await this.seekCaptureIndex(target);
  }

  async seekEvent(eventId: string): Promise<void> {
    this.assertActive();
    const event = this.source.events.find((candidate) => candidate.id === eventId);
    if (event === undefined) throw new RangeError(`Replay event not found: ${eventId}`);
    await this.seekCaptureIndex(event.captureIndex, event.id);
  }

  async stepFrame(direction: -1 | 1): Promise<void> {
    this.assertActive();
    await this.seekCaptureIndex(
      Math.max(0, Math.min(this.source.frames.length - 1, this.snapshot.currentIndex + direction)),
    );
  }

  async stepEvent(direction: -1 | 1): Promise<void> {
    this.assertActive();
    const currentEventIndex = this.source.events.findIndex(
      (event) => event.id === this.snapshot.currentEventId,
    );
    const fallbackIndex = this.source.events.findIndex(
      (event) => event.captureIndex >= this.snapshot.currentIndex,
    );
    const currentIndex = currentEventIndex >= 0 ? currentEventIndex : fallbackIndex;
    const target = this.source.events[currentIndex + direction];
    if (target !== undefined) await this.seekCaptureIndex(target.captureIndex, target.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.abort();
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
    this.snapshot = {
      current: null,
      currentIndex: -1,
      currentEventId: null,
      presentationRevision: this.snapshot.presentationRevision,
      isPlaying: false,
      isSeeking: false,
      error: null,
    };
  }

  abort(): void {
    if (this.disposed) return;
    this.playbackCaptureAnchorUs = this.getPlaybackElapsedUs();
    this.generation += 1;
    this.seekController?.abort();
    this.seekController = undefined;
    this.cancelTimer();
    if (this.snapshot.isPlaying || this.snapshot.isSeeking) {
      this.update({ isPlaying: false, isSeeking: false });
    }
  }

  private scheduleNextFrame(): void {
    if (this.disposed || !this.snapshot.isPlaying) return;
    const nextFrame = this.source.frames[this.snapshot.currentIndex + 1];
    if (nextFrame === undefined) {
      this.update({ isPlaying: false });
      return;
    }
    const deadline =
      this.playbackWallAnchorMs +
      (nextFrame.cursor.scheduledElapsedUs - this.playbackCaptureAnchorUs) / 1000 / this.speed;
    this.timer = this.scheduler.setTimeout(
      () => {
        this.timer = undefined;
        if (this.disposed || !this.snapshot.isPlaying) return;
        const targetCaptureUs =
          this.playbackCaptureAnchorUs +
          (this.scheduler.nowMs() - this.playbackWallAnchorMs) * 1000 * this.speed;
        let targetIndex = this.snapshot.currentIndex;
        while (
          targetIndex + 1 < this.source.frames.length &&
          this.source.frames[targetIndex + 1]!.cursor.scheduledElapsedUs <= targetCaptureUs
        ) {
          targetIndex += 1;
        }
        if (targetIndex > this.snapshot.currentIndex) {
          this.update({
            current: this.source.frames[targetIndex]!,
            currentIndex: targetIndex,
            currentEventId: this.eventIdAt(targetIndex),
          });
        }
        if (targetIndex >= this.source.frames.length - 1) {
          this.playbackCaptureAnchorUs = this.source.frames[targetIndex]!.cursor.scheduledElapsedUs;
          this.update({ isPlaying: false });
        } else this.scheduleNextFrame();
      },
      Math.max(0, deadline - this.scheduler.nowMs()),
    );
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private eventIdAt(captureIndex: number): string | null {
    for (let index = this.source.events.length - 1; index >= 0; index -= 1) {
      const event = this.source.events[index];
      if (event !== undefined && event.captureIndex <= captureIndex) return event.id;
    }
    return null;
  }

  private update(patch: Partial<ReplaySessionSnapshot<Frame>>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Replay session has been disposed');
  }
}

export function createReplaySession<Frame extends ReplaySessionFrame>(
  source: ReplaySessionSource<Frame>,
  scheduler: ReplaySessionScheduler,
): ReplaySession<Frame> {
  return new ReplaySession(source, scheduler);
}
