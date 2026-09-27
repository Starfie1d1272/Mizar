import type { ProgramCueWire } from '@mizar/protocol/program-cue';

import type { ProgramCueClient } from '../realtime/program-cue-client';

export interface ProgramCueEffect {
  readonly cue: ProgramCueWire;
  readonly expiresAtMonotonicMs: number;
}

export interface ProgramCueEffectSnapshot {
  readonly effects: readonly ProgramCueEffect[];
}

export interface ProgramCueEffectScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProgramCueEffectStoreOptions {
  readonly ttlMs: number;
  readonly nowMonotonicMs?: () => number;
  readonly scheduler?: ProgramCueEffectScheduler;
}

const defaultScheduler: ProgramCueEffectScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Renderer-owned ephemeral cue state; TTL never crosses the Local Protocol. */
export class ProgramCueEffectStore {
  private readonly ttlMs: number;
  private readonly nowMonotonicMs: () => number;
  private readonly scheduler: ProgramCueEffectScheduler;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, unknown>();
  private snapshot: ProgramCueEffectSnapshot = { effects: [] };

  constructor(options: ProgramCueEffectStoreOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError('Program cue renderer ttlMs must be finite and non-negative');
    }
    this.ttlMs = options.ttlMs;
    this.nowMonotonicMs =
      options.nowMonotonicMs ?? (() => globalThis.performance?.now() ?? Date.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  getSnapshot = (): ProgramCueEffectSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  accept(cue: ProgramCueWire): void {
    const expiresAtMonotonicMs = this.nowMonotonicMs() + this.ttlMs;
    const effect: ProgramCueEffect = { cue, expiresAtMonotonicMs };
    this.clearTimer(cue.id);
    this.snapshot = {
      effects: [
        ...this.snapshot.effects.filter(({ cue: current }) => current.id !== cue.id),
        effect,
      ],
    };
    this.timers.set(
      cue.id,
      this.scheduler.setTimeout(() => this.expire(cue.id), Math.max(0, this.ttlMs)),
    );
    this.notify();
  }

  reset(): void {
    for (const handle of this.timers.values()) this.scheduler.clearTimeout(handle);
    this.timers.clear();
    if (this.snapshot.effects.length === 0) return;
    this.snapshot = { effects: [] };
    this.notify();
  }

  private expire(cueId: string): void {
    this.timers.delete(cueId);
    const effects = this.snapshot.effects.filter(({ cue }) => cue.id !== cueId);
    if (effects.length === this.snapshot.effects.length) return;
    this.snapshot = { effects };
    this.notify();
  }

  private clearTimer(cueId: string): void {
    const handle = this.timers.get(cueId);
    if (handle === undefined) return;
    this.scheduler.clearTimeout(handle);
    this.timers.delete(cueId);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A renderer observer must not interrupt another observer or cue lifecycle.
      }
    }
  }
}

/** Keep the Renderer seam explicit; the client remains the owner of acceptance and resets. */
export function connectProgramCueRenderer(
  client: ProgramCueClient,
  store: ProgramCueEffectStore,
): () => void {
  const unsubscribeCues = client.subscribeCues((cue) => store.accept(cue));
  const unsubscribeResets = client.subscribeResets(() => store.reset());
  return () => {
    unsubscribeCues();
    unsubscribeResets();
    store.reset();
  };
}
