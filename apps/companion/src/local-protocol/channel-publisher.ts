import {
  createLatestWinsConsumer,
  type LatestWinsConsumer,
  type LatestWinsConsumerDiagnostic,
  type LatestWinsConsumerHealth,
} from '../runtime/latest-wins.js';

export interface SnapshotSchema<TSnapshot> {
  parse(input: unknown): TSnapshot;
}

export interface LocalSubscription {
  close(): Promise<void>;
  getHealth(): LatestWinsConsumerHealth;
}

export interface LocalOutboundSubscription {
  close(): Promise<void>;
}

export interface LocalWebOutboundPublisher<TMessage extends { readonly channelSeq: number }> {
  subscribe(send: (message: TMessage) => Promise<void>): LocalOutboundSubscription;
}

export interface LocalChannelPublisher<
  TSnapshot extends { readonly channelSeq: number },
> extends LocalWebOutboundPublisher<TSnapshot> {
  publish(snapshot: Omit<TSnapshot, 'channelSeq'>): void;
  getCurrent(): TSnapshot | null;
  getHealth?(): readonly LatestWinsConsumerHealth[];
  subscribe(send: (snapshot: TSnapshot) => Promise<void>): LocalSubscription;
  close(): Promise<void>;
}

export interface LocalChannelPublisherOptions<TSnapshot extends { readonly channelSeq: number }> {
  readonly id: string;
  readonly schema: SnapshotSchema<TSnapshot>;
  readonly onDiagnostic?: (diagnostic: { readonly code: string }) => void;
}

function report(
  onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined,
  code: string,
): void {
  try {
    onDiagnostic?.({ code });
  } catch {
    // A channel diagnostic must not affect another subscriber or the publisher.
  }
}

class DefaultLocalChannelPublisher<
  TSnapshot extends { readonly channelSeq: number },
> implements LocalChannelPublisher<TSnapshot> {
  private readonly id: string;
  private readonly schema: SnapshotSchema<TSnapshot>;
  private readonly onDiagnostic: ((diagnostic: { readonly code: string }) => void) | undefined;
  private readonly subscribers = new Map<string, LatestWinsConsumer<TSnapshot>>();
  private current: TSnapshot | null = null;
  private channelSeq = 0;
  private subscriberSequence = 0;
  private closed = false;

  constructor(options: LocalChannelPublisherOptions<TSnapshot>) {
    if (options.id.trim().length === 0)
      throw new Error('Local channel publisher id must be non-empty');
    this.id = options.id;
    this.schema = options.schema;
    this.onDiagnostic = options.onDiagnostic;
  }

  publish(snapshot: Omit<TSnapshot, 'channelSeq'>): void {
    if (this.closed) return;
    const candidate = { ...snapshot, channelSeq: this.channelSeq + 1 } as TSnapshot;
    let parsed: TSnapshot;
    try {
      parsed = this.schema.parse(candidate);
    } catch {
      report(this.onDiagnostic, 'schema-validation-failed');
      return;
    }

    this.channelSeq += 1;
    this.current = parsed;
    for (const subscriber of this.subscribers.values()) subscriber.offer(parsed);
  }

  getHealth(): readonly LatestWinsConsumerHealth[] {
    return [...this.subscribers.values()].map((subscriber) => subscriber.getHealth());
  }

  getCurrent(): TSnapshot | null {
    return this.current;
  }

  subscribe(send: (snapshot: TSnapshot) => Promise<void>): LocalSubscription {
    const subscriberId = `${this.id}-${++this.subscriberSequence}`;
    if (this.closed) {
      return {
        close: () => Promise.resolve(),
        getHealth: () => ({
          id: subscriberId,
          state: 'closed' as const,
          inFlight: false,
          hasPendingLatest: false,
          offered: 0,
          sent: 0,
          coalesced: 0,
          failed: 0,
        }),
      };
    }

    let active = true;
    const consumerRef: { current?: LatestWinsConsumer<TSnapshot> } = {};
    const guardedSend = async (snapshot: TSnapshot): Promise<void> => {
      try {
        await send(snapshot);
      } catch {
        if (active) {
          active = false;
          this.subscribers.delete(subscriberId);
          void consumerRef.current?.close();
          report(this.onDiagnostic, 'subscriber-send-failed');
        }
        throw new Error('local channel subscriber send failed');
      }
    };
    const onDiagnostic = (diagnostic: LatestWinsConsumerDiagnostic) => {
      report(this.onDiagnostic, `subscriber-${diagnostic.code}`);
    };
    const consumer = createLatestWinsConsumer({
      id: subscriberId,
      send: guardedSend,
      onDiagnostic,
    });
    consumerRef.current = consumer;
    this.subscribers.set(subscriberId, consumer);
    if (this.current !== null) consumer.offer(this.current);

    return {
      close: async () => {
        if (!active) return;
        active = false;
        this.subscribers.delete(subscriberId);
        await consumer.close();
      },
      getHealth: () => consumer.getHealth(),
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

export function createLocalChannelPublisher<TSnapshot extends { readonly channelSeq: number }>(
  options: LocalChannelPublisherOptions<TSnapshot>,
): LocalChannelPublisher<TSnapshot> {
  return new DefaultLocalChannelPublisher(options);
}
