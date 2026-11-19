import type { FastifyInstance } from 'fastify';
import type { SessionJournal } from '../support/session-journal.js';
import { registerLocalWebAccess } from './access-policy.js';
import {
  createLocalWebSocketTransport,
  registerLocalWebSocketTransport,
  type LocalWebSocketTransportOptions,
} from './websocket-transport.js';

export function registerLocalWebRuntime(
  app: FastifyInstance,
  options: {
    host: string | undefined;
    lanMode: boolean | undefined;
    allowedOrigins: readonly string[] | undefined;
    sessionJournal: SessionJournal | undefined;
    getPublisher: LocalWebSocketTransportOptions['getPublisher'];
  },
) {
  const localWebTransport = createLocalWebSocketTransport({
    getPublisher: options.getPublisher,
    originPolicyOptions: {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.lanMode === undefined ? {} : { lanMode: options.lanMode }),
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    },
    logger: app.log,
    onDiagnostic: (diagnostic) => {
      options.sessionJournal?.record('local_transport', diagnostic);
      if (diagnostic.code === 'ws_closed' || diagnostic.code === 'ws_connected') return;
      app.log.debug(
        {
          code: diagnostic.code,
          ...(diagnostic.channel === undefined ? {} : { channel: diagnostic.channel }),
          ...(diagnostic.connectionId === undefined
            ? {}
            : { connectionId: diagnostic.connectionId }),
        },
        'Companion local WebSocket diagnostic',
      );
    },
  });
  const originPolicy = localWebTransport.getOriginPolicy();
  registerLocalWebAccess(app, originPolicy);
  registerLocalWebSocketTransport(app, localWebTransport);
  return { transport: localWebTransport, originPolicy };
}
