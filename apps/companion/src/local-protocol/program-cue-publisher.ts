import { performance } from 'node:perf_hooks';

import {
  programCueBaselineSchema,
  programCueMessageSchema,
  type ProgramCueBaselineInput,
  type ProgramCueBaselineV1,
  type ProgramCueLaneMessage,
  type ProgramCueMessageInput,
  type ProgramCueMessageV1,
} from '@mizar/protocol/program-cue';

import type { LocalWebOutboundPublisher } from './channel-publisher.js';

export const PROGRAM_CUE_PENDING_MAX = 32;
export const PROGRAM_CUE_PENDING_MAX_AGE_MS = 1_000;
export const PROGRAM_CUE_CLOSE_TIMEOUT_MS = 10_000;

export type ProgramCuePublisherDiagnosticCode =
  | 'schema-validation-failed'
  | 'cue-before-baseline'
  | 'cursor-mismatch'
  | 'queue-overflow'
  | 'cue-expired'
  | 'subscriber-send-failed'
  | 'delivery-rejected'
  | 'close-timeout';

export interface ProgramCuePublisherDiagnostic {
  readonly code: ProgramCuePublisherDiagnosticCode;
}

export type ProgramCueSubscriptionState = 'idle' | 'sending' | 'closing' | 'closed';

export interface ProgramCueSubscriptionHealth {
  readonly id: string;
  readonly state: ProgramCueSubscriptionState;
  readonly inFlight: boolean;
  readonly pendingCues: number;
  readonly hasPendingReset: boolean;
  readonly offered: number;
  readonly sent: number;
  readonly dropped: number;
  readonly expired: number;
  readonly failed: number;
}

export interface ProgramCueSubscription {
  close(): Promise<void>;
  getHealth(): ProgramCueSubscriptionHealth;
}

export interface ProgramCuePublisherOptions {
  readonly id: string;
  readonly nowMonotonicMs?: () => number;
  readonly pendingMax?: number;
  readonly pendingMaxAgeMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: ProgramCuePublisherDiagnostic) => void;
}

export interface ProgramCuePublisher extends LocalWebOutboundPublisher<ProgramCueLaneMessage> {
  publishBaseline(baseline: ProgramCueBaselineInput): void;
  publishCue(cue: ProgramCueMessageInput): void;
  getCurrent(): ProgramCueBaselineV1 | null;
  subscribe(send: (message: ProgramCueLaneMessage) => Promise<void>): ProgramCueSubscription;
  close(): Promise<void>;
}

interface PendingCue {
  readonly message: ProgramCueMessageV1;
  readonly queuedAtMonotonicMs: number;
}

function sameCursor(
  left: ProgramCueLaneMessage['cursor'],
  right: ProgramCueLaneMessage['cursor'],
): boolean {
  return (
    left.producerInstanceId === right.producerInstanceId &&
    left.liveSessionId === right.liveSessionId &&
    left.mapEpoch === right.mapEpoch &&
    left.cstvProgramGeneration === right.cstvProgramGeneration
  );
}

function report(
  onDiagnostic: ((diagnostic: ProgramCuePublisherDiagnostic) => void) | undefined,
  code: ProgramCuePublisherDiagnosticCode,
): void {
  try {
    onDiagnostic?.({ code });
  } catch {
    // A cue diagnostic must not affect another subscriber or the producer.
  }
}

function closedHealth(id: string): ProgramCueSubscriptionHealth {
  return {
    id,
    state: 'closed',
    inFlight: false,
    pendingCues: 0,
    hasPendingReset: false,
    offered: 0,
    sent: 0,
    dropped: 0,
    expired: 0,
    failed: 0,
  };
}

class ProgramCueSubscriber implements ProgramCueSubscription {
  private readonly id: string;
  private readonly send: (message: ProgramCueLaneMessage) => Promise<void>;
  private readonly nowMonotonicMs: () => number;
  private readonly pendingMax: number;
  private readonly pendingMaxAgeMs: number;
  private readonly closeTimeoutMs: number;
  private readonly onDiagnostic: ((diagnostic: ProgramCuePublisherDiagnostic) => void) | undefined;
  private lifecycle: ProgramCueSubscriptionState = 'idle';
  private inFlight = false;
  private pendingCues: PendingCue[] = [];
  private pendingReset: ProgramCueBaselineV1 | undefined;
  private offered = 0;
  private sent = 0;
  private dropped = 0;
  private expired = 0;
  private failed = 0;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private closeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    id: string,
    send: (message: ProgramCueLaneMessage) => Promise<void>,
    options: {
      readonly nowMonotonicMs: () => number;
      readonly pendingMax: number;
      readonly pendingMaxAgeMs: number;
      readonly closeTimeoutMs: number;
      readonly onDiagnostic?: (diagnostic: ProgramCuePublisherDiagnostic) => void;
    },
  ) {
    this.id = id;
    this.send = send;
    this.nowMonotonicMs = options.nowMonotonicMs;
    this.pendingMax = options.pendingMax;
    this.pendingMaxAgeMs = options.pendingMaxAgeMs;
    this.closeTimeoutMs = options.closeTimeoutMs;
    this.onDiagnostic = options.onDiagnostic;
  }

  offerBaseline(message: ProgramCueBaselineV1): void {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') return;
    this.offered += 1;
    this.pendingCues = [];
    this.pendingReset = message;
    this.drain();
  }

  offerCue(message: ProgramCueMessageV1): void {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') return;
    this.offered += 1;
    if (!this.inFlight && this.pendingReset === undefined && this.pendingCues.length === 0) {
      this.start(message);
      return;
    }

    if (this.pendingCues.length >= this.pendingMax) {
      this.pendingCues.shift();
      this.dropped += 1;
      report(this.onDiagnostic, 'queue-overflow');
    }
    this.pendingCues.push({ message, queuedAtMonotonicMs: this.nowMonotonicMs() });
  }

  getHealth(): ProgramCueSubscriptionHealth {
    return {
      id: this.id,
      state: this.lifecycle,
      inFlight: this.inFlight,
      pendingCues: this.pendingCues.length,
      hasPendingReset: this.pendingReset !== undefined,
      offered: this.offered,
      sent: this.sent,
      dropped: this.dropped,
      expired: this.expired,
      failed: this.failed,
    };
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.lifecycle = 'closing';
    this.pendingCues = [];
    this.pendingReset = undefined;
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    if (!this.inFlight || this.closeTimeoutMs === 0) {
      if (this.inFlight && this.closeTimeoutMs === 0) {
        this.failed += 1;
        report(this.onDiagnostic, 'close-timeout');
      }
      this.finishClose();
      return this.closePromise;
    }
    this.closeTimeoutHandle = setTimeout(() => {
      this.failed += 1;
      report(this.onDiagnostic, 'close-timeout');
      this.finishClose();
    }, this.closeTimeoutMs);
    return this.closePromise;
  }

  private drain(): void {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed' || this.inFlight) return;
    if (this.pendingReset !== undefined) {
      const reset = this.pendingReset;
      this.pendingReset = undefined;
      this.start(reset);
      return;
    }
    while (this.pendingCues.length > 0) {
      const pending = this.pendingCues.shift();
      if (pending === undefined) break;
      if (this.nowMonotonicMs() - pending.queuedAtMonotonicMs > this.pendingMaxAgeMs) {
        this.expired += 1;
        report(this.onDiagnostic, 'cue-expired');
        continue;
      }
      this.start(pending.message);
      return;
    }
    this.lifecycle = 'idle';
  }

  private start(message: ProgramCueLaneMessage): void {
    this.inFlight = true;
    this.lifecycle = 'sending';
    let result: Promise<void>;
    try {
      result = this.send(message);
    } catch {
      this.complete(false);
      return;
    }
    void Promise.resolve(result).then(
      () => this.complete(true),
      () => this.complete(false),
    );
  }

  private complete(succeeded: boolean): void {
    this.inFlight = false;
    if (succeeded) this.sent += 1;
    else {
      this.failed += 1;
      report(this.onDiagnostic, 'delivery-rejected');
    }
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') {
      this.finishClose();
      return;
    }
    this.drain();
  }

  private finishClose(): void {
    if (this.closeTimeoutHandle !== undefined) {
      clearTimeout(this.closeTimeoutHandle);
      this.closeTimeoutHandle = undefined;
    }
    this.lifecycle = 'closed';
    this.pendingCues = [];
    this.pendingReset = undefined;
    const resolve = this.resolveClose;
    this.resolveClose = undefined;
    resolve?.();
  }
}

class DefaultProgramCuePublisher implements ProgramCuePublisher {
  private readonly id: string;
  private readonly nowMonotonicMs: () => number;
  private readonly pendingMax: number;
  private readonly pendingMaxAgeMs: number;
  private readonly closeTimeoutMs: number;
  private readonly onDiagnostic: ((diagnostic: ProgramCuePublisherDiagnostic) => void) | undefined;
  private readonly subscribers = new Map<string, ProgramCueSubscriber>();
  private current: ProgramCueBaselineV1 | null = null;
  private channelSeq = 0;
  private subscriberSequence = 0;
  private closed = false;

  constructor(options: ProgramCuePublisherOptions) {
    if (options.id.trim().length === 0)
      throw new Error('Program cue publisher id must be non-empty');
    const pendingMax = options.pendingMax ?? PROGRAM_CUE_PENDING_MAX;
    const pendingMaxAgeMs = options.pendingMaxAgeMs ?? PROGRAM_CUE_PENDING_MAX_AGE_MS;
    const closeTimeoutMs = options.closeTimeoutMs ?? PROGRAM_CUE_CLOSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(pendingMax) || pendingMax <= 0)
      throw new RangeError('Program cue pendingMax must be a positive safe integer');
    if (!Number.isFinite(pendingMaxAgeMs) || pendingMaxAgeMs < 0)
      throw new RangeError('Program cue pendingMaxAgeMs must be finite and non-negative');
    if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 0)
      throw new RangeError('Program cue closeTimeoutMs must be finite and non-negative');
    this.id = options.id;
    this.nowMonotonicMs = options.nowMonotonicMs ?? (() => performance.now());
    this.pendingMax = pendingMax;
    this.pendingMaxAgeMs = pendingMaxAgeMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.onDiagnostic = options.onDiagnostic;
  }

  publishBaseline(baseline: ProgramCueBaselineInput): void {
    if (this.closed) return;
    const candidate = { ...baseline, channelSeq: this.channelSeq + 1 };
    let parsed: ProgramCueBaselineV1;
    try {
      parsed = programCueBaselineSchema.parse(candidate);
    } catch {
      report(this.onDiagnostic, 'schema-validation-failed');
      return;
    }
    this.channelSeq += 1;
    this.current = parsed;
    for (const subscriber of this.subscribers.values()) subscriber.offerBaseline(parsed);
  }

  publishCue(cue: ProgramCueMessageInput): void {
    if (this.closed) return;
    if (this.current === null) {
      report(this.onDiagnostic, 'cue-before-baseline');
      return;
    }
    const candidate = { ...cue, channelSeq: this.channelSeq + 1 };
    let parsed: ProgramCueMessageV1;
    try {
      parsed = programCueMessageSchema.parse(candidate);
    } catch {
      report(this.onDiagnostic, 'schema-validation-failed');
      return;
    }
    if (!sameCursor(parsed.cursor, this.current.cursor)) {
      report(this.onDiagnostic, 'cursor-mismatch');
      return;
    }
    this.channelSeq += 1;
    for (const subscriber of this.subscribers.values()) subscriber.offerCue(parsed);
  }

  getCurrent(): ProgramCueBaselineV1 | null {
    return this.current;
  }

  subscribe(send: (message: ProgramCueLaneMessage) => Promise<void>): ProgramCueSubscription {
    const subscriberId = `${this.id}-${++this.subscriberSequence}`;
    if (this.closed)
      return { close: () => Promise.resolve(), getHealth: () => closedHealth(subscriberId) };

    let active = true;
    const subscriberRef: { current?: ProgramCueSubscriber } = {};
    const guardedSend = async (message: ProgramCueLaneMessage): Promise<void> => {
      try {
        await send(message);
      } catch {
        if (active) {
          active = false;
          this.subscribers.delete(subscriberId);
          void subscriberRef.current?.close();
          report(this.onDiagnostic, 'subscriber-send-failed');
        }
        throw new Error('program cue subscriber send failed');
      }
    };
    const subscriber = new ProgramCueSubscriber(subscriberId, guardedSend, {
      nowMonotonicMs: this.nowMonotonicMs,
      pendingMax: this.pendingMax,
      pendingMaxAgeMs: this.pendingMaxAgeMs,
      closeTimeoutMs: this.closeTimeoutMs,
      ...(this.onDiagnostic === undefined ? {} : { onDiagnostic: this.onDiagnostic }),
    });
    subscriberRef.current = subscriber;
    this.subscribers.set(subscriberId, subscriber);
    if (this.current !== null) subscriber.offerBaseline(this.current);

    return {
      close: async () => {
        if (!active) return;
        active = false;
        this.subscribers.delete(subscriberId);
        await subscriber.close();
      },
      getHealth: () => subscriber.getHealth(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const subscribers = [...this.subscribers.values()];
    this.subscribers.clear();
    await Promise.all(subscribers.map((subscriber) => subscriber.close()));
  }
}

export function createProgramCuePublisher(
  options: ProgramCuePublisherOptions,
): ProgramCuePublisher {
  return new DefaultProgramCuePublisher(options);
}
