import { ProgramClockTracker } from '@mizar/core/projection';
import type { MulnxInput, MulnxProvider } from './provider.js';

/** Diagnostic clock only; no mapping to lookahead server ticks is implied. */
export class MulnxProgramClock {
  private readonly tracker = new ProgramClockTracker();
  private readonly unsubscribe: () => void;
  private generation: number | null = null;
  private captureGeneration: number | null = null;
  private sampledAt: number | null = null;

  constructor(provider: Pick<MulnxProvider, 'subscribeInput'>) {
    this.unsubscribe = provider.subscribeInput((input) => this.accept(input));
  }

  private accept(input: MulnxInput) {
    if (input.kind === 'subscribed') {
      this.tracker.reset();
      this.generation = input.generation;
      this.captureGeneration = null;
      this.sampledAt = null;
      return;
    }
    if (input.kind === 'disconnected') {
      this.tracker.reset();
      this.generation = null;
      this.captureGeneration = null;
      this.sampledAt = null;
      return;
    }
    if (input.kind !== 'clock' || input.generation !== this.generation) return;
    const sample = input.sample;
    if (this.captureGeneration !== null && sample.captureGeneration < this.captureGeneration)
      return;
    if (this.captureGeneration !== sample.captureGeneration) {
      this.captureGeneration = sample.captureGeneration;
      this.sampledAt = null;
    }
    const ordered = this.sampledAt === null || sample.sampledAtUnixMs > this.sampledAt;
    this.sampledAt = sample.sampledAtUnixMs;
    this.tracker.observe({
      timeDomain: sample.timeDomain,
      continuity: `${input.generation}:${sample.captureGeneration}`,
      tick: sample.tick ?? 0,
      receivedMonotonicMs: sample.receivedMonotonicMs,
      readSucceeded: sample.readSucceeded && ordered,
    });
  }

  current(now: number) {
    return this.tracker.current(now);
  }

  close() {
    this.unsubscribe();
    this.tracker.reset();
  }
}
