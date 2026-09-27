import { createSnapshotAcceptance, type SnapshotAcceptance } from '@mizar/protocol/acceptance';
import type { LocalSnapshotChannel } from '@mizar/protocol/version';

import {
  getLocalChannelConfig,
  LOCAL_PROTOCOL_SUBPROTOCOL,
  type LocalChannelSnapshot,
} from './channel-config';
import {
  LocalChannelStore,
  type LocalChannelStoreListener,
  type LocalChannelStoreSnapshot,
} from './local-channel-store';

export const RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export interface BrowserLocationLike {
  readonly protocol: string;
  readonly host: string;
}

export interface BrowserWebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type WebSocketFactory = (url: string, subprotocol: string) => BrowserWebSocketLike;

export interface LocalChannelClientOptions {
  readonly location?: BrowserLocationLike;
  readonly webSocketFactory?: WebSocketFactory;
  readonly scheduler?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

function defaultLocation(): BrowserLocationLike {
  if (typeof window === 'undefined') {
    throw new Error('LocalChannelClient requires a browser location');
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

export function localWebSocketUrl(path: string, location: BrowserLocationLike): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}

export class LocalChannelClient<C extends LocalSnapshotChannel> {
  readonly channel: C;

  private readonly config: ReturnType<typeof getLocalChannelConfig<C>>;
  private readonly location: BrowserLocationLike;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly scheduler: NonNullable<LocalChannelClientOptions['scheduler']>;
  private readonly store = new LocalChannelStore<LocalChannelSnapshot<C>>();
  private socket: BrowserWebSocketLike | undefined;
  private acceptance: SnapshotAcceptance<LocalChannelSnapshot<C>> | undefined;
  private connectionGeneration = 0;
  private reconnectTimer: unknown;
  private reconnectIndex = 0;
  private disposed = false;

  constructor(channel: C, options: LocalChannelClientOptions = {}) {
    this.channel = channel;
    this.config = getLocalChannelConfig<C>(channel);
    this.location = options.location ?? defaultLocation();
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  getSnapshot = (): LocalChannelStoreSnapshot<LocalChannelSnapshot<C>> => this.store.getSnapshot();

  subscribe = (listener: LocalChannelStoreListener): (() => void) => this.store.subscribe(listener);

  getWebSocketUrl(): string {
    return localWebSocketUrl(this.config.path, this.location);
  }

  start(): void {
    if (this.disposed || this.socket !== undefined || this.reconnectTimer !== undefined) return;
    if (this.store.getSnapshot().state === 'protocol-error') return;
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
    if (socket !== undefined) {
      try {
        socket.close(1000, 'client disposed');
      } catch {
        // A browser may already have destroyed the socket during page unload.
      }
    }
    this.store.setState('closed');
  }

  private connect(): void {
    if (this.disposed) return;
    const generation = ++this.connectionGeneration;
    const acceptance = createSnapshotAcceptance(this.config.schema);
    this.acceptance = acceptance;
    this.store.setState('connecting');

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
      this.store.setState('awaiting-baseline');
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(generation, socket)) return;
      this.handleMessage(generation, socket, event.data);
    };
    socket.onerror = () => {
      // The browser emits close after a failed connection. Waiting for close keeps
      // one failure from scheduling duplicate reconnect timers.
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
      this.handleProtocolError(generation, socket, 'invalid JSON snapshot');
      return;
    }

    const acceptance = this.acceptance;
    if (acceptance === undefined) {
      this.handleProtocolError(generation, socket, 'snapshot arrived before connection setup');
      return;
    }
    const result = acceptance.accept(parsed);
    if (result.kind === 'accepted') {
      if (this.store.getSnapshot().state === 'awaiting-baseline') {
        this.reconnectIndex = 0;
      }
      this.store.accept(result.snapshot, result.reset);
      return;
    }
    if (result.kind === 'ignored') return;
    if (result.reason === 'producer-changed' || result.reason === 'runtime-seq-regression') {
      this.handleRetry(generation, `snapshot ${result.reason}`);
      try {
        socket.close(1002, result.reason);
      } catch {
        // The close event is not required for retry scheduling; the generation guard is.
      }
      return;
    }
    this.handleProtocolError(generation, socket, `snapshot ${result.reason}`);
  }

  private handleProtocolError(
    generation: number,
    socket: BrowserWebSocketLike,
    reason: string,
  ): void {
    if (!this.isCurrent(generation, socket)) return;
    this.invalidateCurrentSocket(generation, socket);
    this.store.setState('protocol-error', reason);
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
    this.store.setState('reconnecting', reason);
    if (this.reconnectTimer !== undefined) return;
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectIndex, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.reconnectIndex = Math.min(this.reconnectIndex + 1, RECONNECT_BACKOFF_MS.length - 1);
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private invalidateCurrentSocket(generation: number, socket: BrowserWebSocketLike): void {
    if (!this.isCurrent(generation, socket)) return;
    this.socket = undefined;
    this.connectionGeneration += 1;
  }

  private isCurrent(generation: number, socket: BrowserWebSocketLike): boolean {
    return !this.disposed && generation === this.connectionGeneration && this.socket === socket;
  }
}

export function createLocalChannelClient<C extends LocalSnapshotChannel>(
  channel: C,
  options: LocalChannelClientOptions = {},
): LocalChannelClient<C> {
  return new LocalChannelClient(channel, options);
}
