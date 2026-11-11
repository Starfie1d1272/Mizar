import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import { randomUUID } from 'node:crypto';
import type { ObsConfig } from './config.js';
import type { ObsRpc } from './reconcile.js';

type ConnectionConfig = Pick<ObsConfig, 'host' | 'port' | 'password'>;
interface ObservationSession {
  readonly client: OBSWebSocket;
  readonly config: ConnectionConfig;
  readonly current: () => boolean;
  readonly context: NonNullable<ObsRpc['observationContext']>;
  ready: Promise<unknown>;
}

/** Shared only by observations. A stalled read never retires the output/transaction socket. */
export class ObsObservationConnection {
  private session: ObservationSession | undefined;
  private closed = false;

  acquire(config: ConnectionConfig): ObservationSession {
    if (this.closed) throw new Error('OBS observations closed');
    const previous = this.session;
    if (
      previous &&
      previous.config.host === config.host &&
      previous.config.port === config.port &&
      previous.config.password === config.password
    )
      return previous;
    this.reset();
    const client = new OBSWebSocket();
    const connectionId = randomUUID();
    let collectionGeneration = 0;
    let inputGeneration = 0;
    for (const event of [
      'CurrentSceneCollectionChanging',
      'CurrentSceneCollectionChanged',
    ] as const)
      client.on(event, () => {
        collectionGeneration++;
      });
    for (const event of [
      'InputCreated',
      'InputRemoved',
      'InputNameChanged',
      'InputSettingsChanged',
    ] as const)
      client.on(event, () => {
        inputGeneration++;
      });
    const session: ObservationSession = {
      client,
      config,
      current: () => this.session === session && !this.closed,
      context: () => ({ connectionId, collectionGeneration, inputGeneration }),
      ready: Promise.resolve(),
    };
    this.session = session;
    client.on('ConnectionClosed', () => {
      if (this.session === session) this.session = undefined;
    });
    client.on('ConnectionError', () => undefined);
    session.ready = client
      .connect(`ws://${config.host}:${config.port}`, config.password, {
        eventSubscriptions:
          EventSubscription.General |
          EventSubscription.Config |
          EventSubscription.Scenes |
          EventSubscription.SceneItems |
          EventSubscription.Inputs |
          EventSubscription.SceneItemTransformChanged,
      })
      .then(async () => {
        if (!session.current()) {
          await client.disconnect().catch(() => undefined);
          throw new Error('OBS observation connection superseded');
        }
      })
      .catch((error: unknown) => {
        this.retire(session);
        throw error;
      });
    return session;
  }

  retire(session: ObservationSession): void {
    if (this.session !== session) return;
    this.session = undefined;
    void session.client.disconnect().catch(() => undefined);
  }

  reset(): void {
    if (this.session) this.retire(this.session);
  }

  async close(): Promise<void> {
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    await session?.client.disconnect().catch(() => undefined);
  }
}
