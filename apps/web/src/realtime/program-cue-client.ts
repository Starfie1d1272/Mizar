import {
  createProgramCueAcceptance,
  type ProgramCueAcceptance,
} from '@mizar/protocol/program-cue-acceptance';
import type {
  ProgramCueBaselineV1,
  ProgramCueLaneCursor,
  ProgramCueWire,
} from '@mizar/protocol/program-cue';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { LOCAL_PROTOCOL_SUBPROTOCOL } from '@mizar/protocol/version';

import {
  localWebSocketUrl,
  type BrowserLocationLike,
  type BrowserWebSocketLike,
  type WebSocketFactory,
} from './local-channel-client';

export const PROGRAM_CUE_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type ProgramCueConnectionState =
  | 'idle'
  | 'connecting'
  | 'awaiting-baseline'
  | 'live'
  | 'reconnecting'
  | 'protocol-error'
  | 'closed';

export type ProgramCueResetReason =
  | 'baseline'
  | 'reconnect'
  | 'protocol-error'
  | 'socket-closed'
  | 'program-snapshot-reset'
  | 'closed';

export interface ProgramCueClientSnapshot {
  readonly state: ProgramCueConnectionState;
  readonly baseline: ProgramCueBaselineV1 | null;
  readonly error: string | null;
}

export interface ProgramCueClientOptions {
  readonly location?: BrowserLocationLike;
  readonly webSocketFactory?: WebSocketFactory;
  readonly scheduler?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly getProgramSnapshot?: () => ProgramSnapshot | null;
  readonly onCue?: (cue: ProgramCueWire) => void;
  readonly onReset?: (reason: ProgramCueResetReason) => void;
}

export type ProgramCueListener = () => void;
export type ProgramCueEventListener = (cue: ProgramCueWire) => void;
export type ProgramCueResetListener = (reason: ProgramCueResetReason) => void;

const PROGRAM_CUE_PATH = '/local/v1/program-cue';

function defaultLocation(): BrowserLocationLike {
  if (typeof window === 'undefined') {
    throw new Error('ProgramCueClient requires a browser location');
  }
  return window.location;
}

function defaultWebSocketFactory(url: string, subprotocol: string): BrowserWebSocketLike {
  return new WebSocket(url, subprotocol) as unknown as BrowserWebSocketLike;
}

const defaultScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
};

function sameLaneCursor(left: ProgramCueLaneCursor, right: ProgramCueLaneCursor): boolean {
  return (
    left.producerInstanceId === right.producerInstanceId &&
    left.liveSessionId === right.liveSessionId &&
    left.mapEpoch === right.mapEpoch &&
    left.cstvProgramGeneration === right.cstvProgramGeneration
  );
}

function sameProgramContinuity(
  left: ProgramSnapshot['cursor'],
  right: ProgramSnapshot['cursor'],
): boolean {
  return (
    left.producerInstanceId === right.producerInstanceId &&
    left.liveSessionId === right.liveSessionId &&
    left.mapEpoch === right.mapEpoch &&
    left.programSourceGeneration === right.programSourceGeneration
  );
}

export class ProgramCueClient {
  private readonly location: BrowserLocationLike;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly scheduler: NonNullable<ProgramCueClientOptions['scheduler']>;
  private readonly getProgramSnapshot: (() => ProgramSnapshot | null) | undefined;
  private readonly onCue: ((cue: ProgramCueWire) => void) | undefined;
  private readonly onReset: ((reason: ProgramCueResetReason) => void) | undefined;
  private readonly listeners = new Set<ProgramCueListener>();
  private readonly cueListeners = new Set<ProgramCueEventListener>();
  private readonly resetListeners = new Set<ProgramCueResetListener>();
  private snapshot: ProgramCueClientSnapshot = {
    state: 'idle',
    baseline: null,
    error: null,
  };
  private socket: BrowserWebSocketLike | undefined;
  private acceptance: ProgramCueAcceptance | undefined;
  private currentProgramSnapshot: ProgramSnapshot | null = null;
  private connectionGeneration = 0;
  private reconnectTimer: unknown;
  private reconnectIndex = 0;
  private disposed = false;

  constructor(options: ProgramCueClientOptions = {}) {
    this.location = options.location ?? defaultLocation();
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.getProgramSnapshot = options.getProgramSnapshot;
    this.onCue = options.onCue;
    this.onReset = options.onReset;
  }

  getSnapshot = (): ProgramCueClientSnapshot => this.snapshot;

  subscribe = (listener: ProgramCueListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeCues = (listener: ProgramCueEventListener): (() => void) => {
    this.cueListeners.add(listener);
    return () => this.cueListeners.delete(listener);
  };

  subscribeResets = (listener: ProgramCueResetListener): (() => void) => {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  };

  getWebSocketUrl(): string {
    return localWebSocketUrl(PROGRAM_CUE_PATH, this.location);
  }

  start(): void {
    if (this.disposed || this.socket !== undefined || this.reconnectTimer !== undefined) return;
    if (this.snapshot.state === 'protocol-error') return;
    this.connect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connectionGeneration += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.acceptance = undefined;
    if (socket !== undefined) {
      try {
        socket.close(1000, 'client disposed');
      } catch {
        // A browser may already have destroyed the socket during page unload.
      }
    }
    this.resetEphemeral('closed');
    this.update({ state: 'closed', baseline: null, error: null });
  }

  observeProgramSnapshot(snapshot: ProgramSnapshot | null): void {
    const previous = this.currentProgramSnapshot;
    this.currentProgramSnapshot = snapshot;
    if (
      !this.disposed &&
      previous !== null &&
      (snapshot === null || !sameProgramContinuity(previous.cursor, snapshot.cursor))
    ) {
      this.resubscribeAfterProgramSnapshotReset();
    }
  }

  private resubscribeAfterProgramSnapshotReset(): void {
    const shouldReconnect =
      this.snapshot.state === 'connecting' ||
      this.snapshot.state === 'awaiting-baseline' ||
      this.snapshot.state === 'live' ||
      this.snapshot.state === 'reconnecting';

    if (this.reconnectTimer !== undefined) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;
    this.acceptance = undefined;
    this.connectionGeneration += 1;
    this.reconnectIndex = 0;

    this.resetEphemeral('program-snapshot-reset');
    this.update({
      state: shouldReconnect ? 'connecting' : this.snapshot.state,
      baseline: null,
      error: null,
    });

    if (socket !== undefined) {
      try {
        socket.close(1000, 'program snapshot reset');
      } catch {
        // The old socket is already invalidated by connectionGeneration.
      }
    }

    if (shouldReconnect) this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    const generation = ++this.connectionGeneration;
    const acceptance = createProgramCueAcceptance();
    this.acceptance = acceptance;
    this.update({ state: 'connecting', baseline: null, error: null });

    let socket: BrowserWebSocketLike;
    try {
      socket = this.webSocketFactory(this.getWebSocketUrl(), LOCAL_PROTOCOL_SUBPROTOCOL);
    } catch (error: unknown) {
      this.handleRetry(generation, error instanceof Error ? error.message : 'WebSocket 创建失败');
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrent(generation, socket)) return;
      if (socket.protocol !== LOCAL_PROTOCOL_SUBPROTOCOL) {
        this.handleProtocolError(generation, socket, 'subprotocol mismatch');
        return;
      }
      this.update({ state: 'awaiting-baseline', baseline: null, error: null });
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(generation, socket)) return;
      this.handleMessage(generation, socket, event.data);
    };
    socket.onerror = () => {
      // The browser emits close after a failed connection; close schedules one retry.
    };
    socket.onclose = () => {
      if (!this.isCurrent(generation, socket)) return;
      this.socket = undefined;
      this.handleRetry(generation, 'WebSocket closed');
    };
  }

  private handleMessage(generation: number, socket: BrowserWebSocketLike, data: unknown): void {
    if (typeof data !== 'string') {
      this.handleProtocolError(generation, socket, 'binary/non-text application message');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.handleProtocolError(generation, socket, 'invalid JSON cue message');
      return;
    }
    const acceptance = this.acceptance;
    if (acceptance === undefined) {
      this.handleProtocolError(generation, socket, 'cue arrived before connection setup');
      return;
    }
    const result = acceptance.accept(parsed);
    if (result.kind === 'ignored') return;
    if (result.kind === 'rejected') {
      this.handleProtocolError(generation, socket, `cue ${result.reason}`);
      return;
    }
    if (result.message.type === 'cue-baseline') {
      this.reconnectIndex = 0;
      this.update({ state: 'live', baseline: result.message, error: null });
      if (result.reset) this.resetEphemeral('baseline');
      return;
    }
    const programSnapshot =
      this.getProgramSnapshot === undefined
        ? this.currentProgramSnapshot
        : this.getProgramSnapshot();
    if (
      programSnapshot === null ||
      !sameLaneCursor(result.message.cursor, {
        producerInstanceId: programSnapshot.cursor.producerInstanceId,
        liveSessionId: programSnapshot.cursor.liveSessionId,
        mapEpoch: programSnapshot.cursor.mapEpoch,
        cstvProgramGeneration: result.message.cursor.cstvProgramGeneration,
      })
    ) {
      return;
    }
    this.emitCue(result.message.cue);
  }

  private handleProtocolError(
    generation: number,
    socket: BrowserWebSocketLike,
    reason: string,
  ): void {
    if (!this.isCurrent(generation, socket)) return;
    this.socket = undefined;
    this.connectionGeneration += 1;
    this.acceptance = undefined;
    this.resetEphemeral('protocol-error');
    this.update({ state: 'protocol-error', baseline: null, error: reason });
    try {
      socket.close(1002, reason);
    } catch {
      // The connection may already be closed.
    }
  }

  private handleRetry(generation: number, reason: string): void {
    if (this.disposed || generation !== this.connectionGeneration) return;
    this.socket = undefined;
    this.connectionGeneration += 1;
    this.acceptance = undefined;
    this.resetEphemeral('reconnect');
    this.update({ state: 'reconnecting', baseline: null, error: reason });
    if (this.reconnectTimer !== undefined) return;
    const delay =
      PROGRAM_CUE_RECONNECT_BACKOFF_MS[
        Math.min(this.reconnectIndex, PROGRAM_CUE_RECONNECT_BACKOFF_MS.length - 1)
      ]!;
    this.reconnectIndex = Math.min(
      this.reconnectIndex + 1,
      PROGRAM_CUE_RECONNECT_BACKOFF_MS.length - 1,
    );
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private emitCue(cue: ProgramCueWire): void {
    for (const listener of [...this.cueListeners]) {
      try {
        listener(cue);
      } catch {
        // A renderer listener must not break cue acceptance for other consumers.
      }
    }
    try {
      this.onCue?.(cue);
    } catch {
      // The optional renderer callback is observational.
    }
  }

  private resetEphemeral(reason: ProgramCueResetReason): void {
    for (const listener of [...this.resetListeners]) {
      try {
        listener(reason);
      } catch {
        // A renderer reset listener must not break the connection lifecycle.
      }
    }
    try {
      this.onReset?.(reason);
    } catch {
      // The optional renderer callback is observational.
    }
  }

  private update(patch: Partial<ProgramCueClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // UI observers must not affect protocol acceptance.
      }
    }
  }

  private isCurrent(generation: number, socket: BrowserWebSocketLike): boolean {
    return !this.disposed && generation === this.connectionGeneration && this.socket === socket;
  }
}

export function createProgramCueClient(options: ProgramCueClientOptions = {}): ProgramCueClient {
  return new ProgramCueClient(options);
}
