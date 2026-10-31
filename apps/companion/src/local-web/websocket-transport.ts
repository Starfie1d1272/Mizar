import { randomUUID } from 'node:crypto';

import fastifyWebsocket from '@fastify/websocket';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket as WsSocket } from 'ws';
import { LOCAL_PROTOCOL_SUBPROTOCOL, LOCAL_SNAPSHOT_VERSIONS } from '@mizar/protocol/version';

import type { LocalWebOutboundPublisher } from '../local-protocol/channel-publisher.js';
import {
  HEARTBEAT_INTERVAL_MS,
  LOCAL_WEB_ROUTES,
  LOCAL_WEB_SUBPROTOCOL,
  LOCAL_WEB_WS_MAX_PAYLOAD_BYTES,
  MAX_LOCAL_SNAPSHOT_BYTES,
  MAX_LOCAL_WS_BUFFER_BYTES,
  type LocalWebChannel,
} from './transport-constants.js';
import {
  checkLocalWebOrigin,
  createLocalWebOriginPolicy,
  type LocalWebOriginPolicy,
  type LocalWebOriginPolicyOptions,
} from './origin-policy.js';

const OPEN_STATE = 1;
const READ_ONLY_CLOSE_CODE = 1008;
const SNAPSHOT_TOO_LARGE_CLOSE_CODE = 1009;
const CONNECTION_LIMIT_CLOSE_CODE = 1013;
export const MAX_LOCAL_WS_CONNECTIONS = 64;
const HOST_EVENT_LIMIT = 32;

type LocalWebMessage = { readonly channel: string; readonly channelSeq: number };

export interface LocalWebSocketLike extends Pick<
  WsSocket,
  'bufferedAmount' | 'readyState' | 'protocol'
> {
  send(data: string, callback: (error?: Error | null) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: 'pong', listener: () => void): this;
}

interface HeartbeatScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultHeartbeatScheduler: HeartbeatScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export type LocalWebSocketDiagnosticCode =
  | 'ws_connected'
  | 'ws_closed'
  | 'connection_limit_rejected'
  | 'origin_rejected'
  | 'subprotocol_rejected'
  | 'slow_consumer_terminated'
  | 'snapshot_oversize'
  | 'heartbeat_terminated'
  | 'send_failed'
  | 'client_message_rejected';

export type LocalWebHostKind = 'obs' | 'browser' | 'unknown';

export interface LocalWebHostEvent {
  readonly sequence: number;
  readonly at: string;
  readonly action: 'connected' | 'disconnected';
  readonly host: LocalWebHostKind;
  readonly channel: LocalWebChannel;
  readonly obsVersion?: string;
}

export interface LocalWebHostDiagnostics {
  readonly active: {
    readonly obs: number;
    readonly browser: number;
    readonly unknown: number;
    readonly byChannel: Readonly<Record<LocalWebChannel, number>>;
    readonly byHostChannel: Readonly<
      Record<LocalWebHostKind, Readonly<Record<LocalWebChannel, number>>>
    >;
    readonly obsVersions: readonly string[];
  };
  readonly totals: {
    readonly connected: number;
    readonly disconnected: number;
    readonly connectionLimitRejected: number;
    readonly slowConsumerTerminated: number;
    readonly snapshotOversize: number;
    readonly heartbeatTerminated: number;
    readonly sendFailed: number;
  };
  readonly recentEvents: readonly LocalWebHostEvent[];
}

export interface LocalWebSocketDiagnostic {
  readonly code: LocalWebSocketDiagnosticCode;
  readonly channel?: LocalWebChannel;
  readonly connectionId?: string;
  readonly bufferedBytes?: number;
  readonly origin?: string;
  readonly reason?: string;
  readonly host?: LocalWebHostKind;
}

export interface LocalWebSocketTransportOptions {
  readonly getPublisher: (channel: LocalWebChannel) => LocalWebOutboundPublisher<LocalWebMessage>;
  readonly originPolicy?: LocalWebOriginPolicy;
  readonly originPolicyOptions?: LocalWebOriginPolicyOptions;
  readonly logger?: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  readonly onDiagnostic?: (diagnostic: LocalWebSocketDiagnostic) => void;
  readonly heartbeatScheduler?: HeartbeatScheduler;
  readonly heartbeatIntervalMs?: number;
  readonly connectionId?: () => string;
}

interface Connection {
  readonly id: string;
  readonly channel: LocalWebChannel;
  readonly socket: LocalWebSocketLike;
  readonly origin: string | undefined;
  readonly host: LocalWebHostKind;
  readonly obsVersion?: string;
  readonly publisher: LocalWebOutboundPublisher<LocalWebMessage>;
  subscription?: { close(): Promise<void> };
  alive: boolean;
  closed: boolean;
}

function report(
  onDiagnostic: ((diagnostic: LocalWebSocketDiagnostic) => void) | undefined,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'> | undefined,
  diagnostic: LocalWebSocketDiagnostic,
): void {
  try {
    onDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics must never interrupt a socket lifecycle callback.
  }
  const fields = {
    ...(diagnostic.channel === undefined ? {} : { channel: diagnostic.channel }),
    ...(diagnostic.connectionId === undefined ? {} : { connectionId: diagnostic.connectionId }),
    ...(diagnostic.bufferedBytes === undefined ? {} : { bufferedBytes: diagnostic.bufferedBytes }),
    ...(diagnostic.origin === undefined ? {} : { origin: diagnostic.origin }),
    ...(diagnostic.reason === undefined ? {} : { reason: diagnostic.reason }),
  };
  const message = `local WebSocket ${diagnostic.code}`;
  if (
    diagnostic.code === 'origin_rejected' ||
    diagnostic.code === 'subprotocol_rejected' ||
    diagnostic.code === 'connection_limit_rejected' ||
    diagnostic.code === 'slow_consumer_terminated' ||
    diagnostic.code === 'snapshot_oversize' ||
    diagnostic.code === 'heartbeat_terminated' ||
    diagnostic.code === 'send_failed' ||
    diagnostic.code === 'client_message_rejected'
  ) {
    logger?.warn(fields, message);
  } else {
    logger?.info(fields, message);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(',');
  return value;
}

function requestedProtocols(value: string | string[] | undefined): readonly string[] {
  return (headerValue(value) ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
}

function closeSocket(socket: LocalWebSocketLike, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function classifyHost(userAgent: string | undefined): {
  readonly host: LocalWebHostKind;
  readonly obsVersion?: string;
} {
  if (userAgent === undefined) return { host: 'unknown' };
  const obsVersion = /(?:^|\s)OBS\/(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.\d{1,3})?(?=\s|$)/i.exec(
    userAgent,
  )?.[1];
  if (obsVersion !== undefined) return { host: 'obs', obsVersion };
  if (/(?:Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|Safari)\//i.test(userAgent)) {
    return { host: 'browser' };
  }
  return { host: 'unknown' };
}

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

export class LocalWebSocketTransport {
  private readonly getPublisher: LocalWebSocketTransportOptions['getPublisher'];
  private readonly originPolicy: LocalWebOriginPolicy;
  private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'> | undefined;
  private readonly onDiagnostic: ((diagnostic: LocalWebSocketDiagnostic) => void) | undefined;
  private readonly heartbeatScheduler: HeartbeatScheduler;
  private readonly heartbeatIntervalMs: number;
  private readonly connectionId: () => string;
  private readonly connections = new Map<string, Connection>();
  private readonly totals = {
    connected: 0,
    disconnected: 0,
    connectionLimitRejected: 0,
    slowConsumerTerminated: 0,
    snapshotOversize: 0,
    heartbeatTerminated: 0,
    sendFailed: 0,
  };
  private readonly hostEvents: LocalWebHostEvent[] = [];
  private hostEventSequence = 0;
  private heartbeatTimer: unknown;
  private closed = false;

  constructor(options: LocalWebSocketTransportOptions) {
    this.getPublisher = options.getPublisher;
    this.originPolicy =
      options.originPolicy ?? createLocalWebOriginPolicy(options.originPolicyOptions);
    this.logger = options.logger;
    this.onDiagnostic = options.onDiagnostic;
    this.heartbeatScheduler = options.heartbeatScheduler ?? defaultHeartbeatScheduler;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.connectionId = options.connectionId ?? (() => randomUUID().slice(0, 8));
  }

  getOriginPolicy(): LocalWebOriginPolicy {
    return this.originPolicy;
  }

  getHostDiagnostics(): LocalWebHostDiagnostics {
    const active = { obs: 0, browser: 0, unknown: 0 };
    const byChannel: Record<LocalWebChannel, number> = {
      program: 0,
      radar: 0,
      operator: 0,
      assist: 0,
      'program-cue': 0,
    };
    const byHostChannel: Record<LocalWebHostKind, Record<LocalWebChannel, number>> = {
      obs: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
      browser: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
      unknown: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
    };
    const obsVersions = new Set<string>();
    for (const connection of this.connections.values()) {
      active[connection.host] = increment(active[connection.host]);
      byChannel[connection.channel] = increment(byChannel[connection.channel]);
      byHostChannel[connection.host][connection.channel] = increment(
        byHostChannel[connection.host][connection.channel],
      );
      if (connection.obsVersion !== undefined) obsVersions.add(connection.obsVersion);
    }
    return {
      active: {
        ...active,
        byChannel,
        byHostChannel,
        obsVersions: [...obsVersions].sort().slice(0, MAX_LOCAL_WS_CONNECTIONS),
      },
      totals: { ...this.totals },
      recentEvents: this.hostEvents.map((event) => ({ ...event })),
    };
  }

  attach(
    channel: LocalWebChannel,
    socket: LocalWebSocketLike,
    origin: string | undefined,
    userAgent?: string,
  ): void {
    if (this.closed) {
      socket.terminate();
      return;
    }

    if (this.connections.size >= MAX_LOCAL_WS_CONNECTIONS) {
      this.totals.connectionLimitRejected = increment(this.totals.connectionLimitRejected);
      report(this.onDiagnostic, this.logger, {
        code: 'connection_limit_rejected',
        channel,
        reason: 'local WebSocket connection limit reached',
      });
      closeSocket(socket, CONNECTION_LIMIT_CLOSE_CODE, 'local connection limit reached');
      return;
    }

    const id = this.connectionId();
    const host = classifyHost(userAgent);
    const connection: Connection = {
      id,
      channel,
      socket,
      origin,
      ...host,
      publisher: this.getPublisher(channel),
      alive: true,
      closed: false,
    };
    this.connections.set(id, connection);
    this.totals.connected = increment(this.totals.connected);
    this.recordHostEvent(connection, 'connected');
    this.ensureHeartbeatTimer();
    report(this.onDiagnostic, this.logger, {
      code: 'ws_connected',
      channel,
      connectionId: id,
      host: connection.host,
    });

    socket.on('pong', () => {
      if (!connection.closed) connection.alive = true;
    });
    socket.on('message', () => {
      if (connection.closed) return;
      report(this.onDiagnostic, this.logger, {
        code: 'client_message_rejected',
        channel,
        connectionId: id,
        reason: 'read-only local snapshot channel',
      });
      closeSocket(socket, READ_ONLY_CLOSE_CODE, 'read-only local snapshot channel');
    });
    socket.on('error', (error) => {
      if (connection.closed) return;
      this.countTransportDiagnostic('send_failed');
      report(this.onDiagnostic, this.logger, {
        code: 'send_failed',
        channel,
        connectionId: id,
        reason: error.message,
      });
      socket.terminate();
      void this.cleanup(connection, 'socket_error');
    });
    socket.on('close', (code, reason) => {
      void this.cleanup(connection, `close:${code}:${reason.toString()}`);
    });

    const subscription = connection.publisher.subscribe(async (snapshot) => {
      try {
        await this.sendSnapshot(connection, snapshot);
      } catch (error: unknown) {
        if (!connection.closed) {
          this.countTransportDiagnostic('send_failed');
          report(this.onDiagnostic, this.logger, {
            code: 'send_failed',
            channel: connection.channel,
            connectionId: connection.id,
            reason: error instanceof Error ? error.message : 'local WebSocket send failed',
          });
          connection.socket.terminate();
          void this.cleanup(connection, 'send_failed');
        }
        throw error;
      }
    });
    connection.subscription = subscription;
    if (connection.closed) void subscription.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer !== undefined) {
      this.heartbeatScheduler.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const connections = [...this.connections.values()];
    for (const connection of connections) closeSocket(connection.socket, 1001, 'server shutdown');
    await Promise.all(connections.map((connection) => this.cleanup(connection, 'server_shutdown')));
  }

  private ensureHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) return;
    const timer = this.heartbeatScheduler.setInterval(() => {
      for (const connection of this.connections.values()) {
        if (connection.closed) continue;
        if (!connection.alive) {
          this.countTransportDiagnostic('heartbeat_terminated');
          report(this.onDiagnostic, this.logger, {
            code: 'heartbeat_terminated',
            channel: connection.channel,
            connectionId: connection.id,
          });
          connection.socket.terminate();
          void this.cleanup(connection, 'heartbeat_terminated');
          continue;
        }
        connection.alive = false;
        try {
          connection.socket.ping();
        } catch (error: unknown) {
          this.countTransportDiagnostic('send_failed');
          report(this.onDiagnostic, this.logger, {
            code: 'send_failed',
            channel: connection.channel,
            connectionId: connection.id,
            reason: error instanceof Error ? error.message : 'heartbeat ping failed',
          });
          connection.socket.terminate();
          void this.cleanup(connection, 'heartbeat_ping_failed');
        }
      }
      if (this.connections.size === 0 && this.heartbeatTimer !== undefined) {
        this.heartbeatScheduler.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer = timer;
    const unref = (timer as { unref?: () => void }).unref;
    unref?.call(timer);
  }

  private async sendSnapshot(connection: Connection, snapshot: LocalWebMessage): Promise<void> {
    if (connection.closed || connection.socket.readyState !== OPEN_STATE) {
      throw new Error('local WebSocket is not open');
    }
    if (connection.socket.bufferedAmount > MAX_LOCAL_WS_BUFFER_BYTES) {
      this.countTransportDiagnostic('slow_consumer_terminated');
      report(this.onDiagnostic, this.logger, {
        code: 'slow_consumer_terminated',
        channel: connection.channel,
        connectionId: connection.id,
        bufferedBytes: connection.socket.bufferedAmount,
      });
      connection.socket.terminate();
      void this.cleanup(connection, 'slow_consumer_terminated');
      throw new Error('local WebSocket bufferedAmount exceeded limit');
    }

    const serialized = JSON.stringify(snapshot);
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes > MAX_LOCAL_SNAPSHOT_BYTES) {
      this.countTransportDiagnostic('snapshot_oversize');
      report(this.onDiagnostic, this.logger, {
        code: 'snapshot_oversize',
        channel: connection.channel,
        connectionId: connection.id,
        bufferedBytes: serializedBytes,
      });
      closeSocket(
        connection.socket,
        SNAPSHOT_TOO_LARGE_CLOSE_CODE,
        'local snapshot exceeds 256 KiB',
      );
      void this.cleanup(connection, 'snapshot_oversize');
      throw new Error('local snapshot exceeds 256 KiB');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        if (error === undefined || error === null) resolve();
        else reject(error);
      };
      try {
        connection.socket.send(serialized, (error) => settle(error));
      } catch (error: unknown) {
        settle(error instanceof Error ? error : new Error('local WebSocket send failed'));
      }
      if (connection.socket.bufferedAmount > MAX_LOCAL_WS_BUFFER_BYTES) {
        this.countTransportDiagnostic('slow_consumer_terminated');
        report(this.onDiagnostic, this.logger, {
          code: 'slow_consumer_terminated',
          channel: connection.channel,
          connectionId: connection.id,
          bufferedBytes: connection.socket.bufferedAmount,
        });
        connection.socket.terminate();
        void this.cleanup(connection, 'slow_consumer_terminated');
        settle(new Error('local WebSocket bufferedAmount exceeded limit'));
      }
    });
  }

  private async cleanup(connection: Connection, reason: string): Promise<void> {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection.id);
    this.totals.disconnected = increment(this.totals.disconnected);
    this.recordHostEvent(connection, 'disconnected');
    await connection.subscription?.close();
    report(this.onDiagnostic, this.logger, {
      code: 'ws_closed',
      channel: connection.channel,
      connectionId: connection.id,
      ...(connection.origin === undefined ? {} : { origin: connection.origin }),
      reason,
    });
    if (this.connections.size === 0 && this.heartbeatTimer !== undefined) {
      this.heartbeatScheduler.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private recordHostEvent(connection: Connection, action: LocalWebHostEvent['action']): void {
    const event: LocalWebHostEvent = {
      sequence: increment(this.hostEventSequence),
      at: new Date().toISOString(),
      action,
      host: connection.host,
      channel: connection.channel,
      ...(connection.obsVersion === undefined ? {} : { obsVersion: connection.obsVersion }),
    };
    this.hostEventSequence = event.sequence;
    this.hostEvents.push(event);
    if (this.hostEvents.length > HOST_EVENT_LIMIT) this.hostEvents.shift();
  }

  private countTransportDiagnostic(
    code: 'slow_consumer_terminated' | 'snapshot_oversize' | 'heartbeat_terminated' | 'send_failed',
  ): void {
    switch (code) {
      case 'slow_consumer_terminated':
        this.totals.slowConsumerTerminated = increment(this.totals.slowConsumerTerminated);
        break;
      case 'snapshot_oversize':
        this.totals.snapshotOversize = increment(this.totals.snapshotOversize);
        break;
      case 'heartbeat_terminated':
        this.totals.heartbeatTerminated = increment(this.totals.heartbeatTerminated);
        break;
      case 'send_failed':
        this.totals.sendFailed = increment(this.totals.sendFailed);
        break;
    }
  }
}

export function registerLocalWebSocketTransport(
  app: FastifyInstance,
  transport: LocalWebSocketTransport,
): void {
  app.get('/local/protocol', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      subprotocol: LOCAL_PROTOCOL_SUBPROTOCOL,
      channels: LOCAL_SNAPSHOT_VERSIONS,
    }),
  );
  const policy = transport.getOriginPolicy();
  app.register(fastifyWebsocket, {
    options: {
      perMessageDeflate: false,
      maxPayload: LOCAL_WEB_WS_MAX_PAYLOAD_BYTES,
      handleProtocols: () => LOCAL_WEB_SUBPROTOCOL,
    },
  });

  app.register((instance, _options, done) => {
    instance.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?', 1)[0] ?? '';
      if (!Object.values(LOCAL_WEB_ROUTES).some((route) => route === pathname)) {
        return;
      }
      if (request.headers.upgrade?.toLowerCase() !== 'websocket') return;

      const protocols = requestedProtocols(request.headers['sec-websocket-protocol']);
      if (protocols.length !== 1 || protocols[0] !== LOCAL_WEB_SUBPROTOCOL) {
        report(undefined, app.log, {
          code: 'subprotocol_rejected',
          reason: 'unsupported local WebSocket subprotocol',
        });
        reply.code(426).send('Upgrade Required');
        return;
      }
      const origin = request.headers.origin;
      const originResult = checkLocalWebOrigin(policy, origin);
      if (!originResult.allowed) {
        report(undefined, app.log, {
          code: 'origin_rejected',
          ...(origin === undefined ? {} : { origin }),
          reason: originResult.reason,
        });
        reply.code(403).send('Forbidden');
        return;
      }
    });

    for (const [channel, route] of Object.entries(LOCAL_WEB_ROUTES) as [
      LocalWebChannel,
      string,
    ][]) {
      instance.get(route, { websocket: true }, (socket, request) => {
        transport.attach(
          channel,
          socket,
          request.headers.origin,
          headerValue(request.headers['user-agent']),
        );
      });
    }
    done();
  });
}

export function createLocalWebSocketTransport(
  options: LocalWebSocketTransportOptions,
): LocalWebSocketTransport {
  return new LocalWebSocketTransport(options);
}
