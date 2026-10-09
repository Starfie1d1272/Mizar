import { describe, expect, it } from 'vitest';

import { createLatestWinsConsumer } from '../src/runtime/latest-wins.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('latest-wins consumer', () => {
  it('keeps only the newest pending snapshot while a send is in flight', async () => {
    const first = deferred();
    const sent: string[] = [];
    const consumer = createLatestWinsConsumer({
      id: 'debug-fixture',
      send: (snapshot: string) => {
        sent.push(snapshot);
        return snapshot === 'A' ? first.promise : Promise.resolve();
      },
    });

    consumer.offer('A');
    consumer.offer('B');
    consumer.offer('C');

    expect(sent).toEqual(['A']);
    expect(consumer.getHealth()).toMatchObject({
      state: 'sending',
      inFlight: true,
      hasPendingLatest: true,
      offered: 3,
      sent: 0,
      coalesced: 1,
      failed: 0,
    });

    first.resolve();
    await flushMicrotasks();

    expect(sent).toEqual(['A', 'C']);
    expect(consumer.getHealth()).toMatchObject({
      state: 'idle',
      inFlight: false,
      hasPendingLatest: false,
      sent: 2,
    });
    await consumer.close();
  });

  it('keeps one in-flight and one pending slot under 10k offers', () => {
    const blocked = deferred();
    const consumer = createLatestWinsConsumer({
      id: 'bounded-fixture',
      send: () => blocked.promise,
    });

    consumer.offer(0);
    for (let index = 1; index < 10_000; index += 1) consumer.offer(index);

    expect(consumer.getHealth()).toMatchObject({
      inFlight: true,
      hasPendingLatest: true,
      offered: 10_000,
      coalesced: 9_998,
    });
  });

  it('isolates a blocked consumer from a fast consumer', async () => {
    const blocked = deferred();
    const slowSent: string[] = [];
    const fastSent: string[] = [];
    const slow = createLatestWinsConsumer({
      id: 'slow',
      send: (snapshot: string) => {
        slowSent.push(snapshot);
        return blocked.promise;
      },
    });
    const fast = createLatestWinsConsumer({
      id: 'fast',
      send: (snapshot: string) => {
        fastSent.push(snapshot);
        return Promise.resolve();
      },
    });

    slow.offer('slow-1');
    slow.offer('slow-2');
    fast.offer('fast-1');
    await flushMicrotasks();

    expect(slowSent).toEqual(['slow-1']);
    expect(fastSent).toEqual(['fast-1']);
    expect(fast.getHealth().state).toBe('idle');

    blocked.resolve();
    await flushMicrotasks();
    expect(slowSent).toEqual(['slow-1', 'slow-2']);

    await Promise.all([slow.close(), fast.close()]);
  });

  it('records rejection without poisoning later delivery', async () => {
    let rejectNext = true;
    const diagnostics: string[] = [];
    const consumer = createLatestWinsConsumer({
      id: 'recovering',
      send: () => {
        if (rejectNext) {
          rejectNext = false;
          return Promise.reject(new Error('temporary failure'));
        }
        return Promise.resolve();
      },
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });

    consumer.offer('first');
    await flushMicrotasks();
    expect(consumer.getHealth()).toMatchObject({
      state: 'idle',
      sent: 0,
      failed: 1,
      lastErrorCode: 'delivery_rejected',
    });
    expect(diagnostics).toEqual(['delivery_rejected']);

    consumer.offer('second');
    await flushMicrotasks();
    expect(consumer.getHealth()).toMatchObject({ sent: 1, failed: 1, state: 'idle' });
    await consumer.close();
  });

  it('stops admission and closes idempotently after the in-flight send settles', async () => {
    const blocked = deferred();
    const sent: string[] = [];
    const consumer = createLatestWinsConsumer({
      id: 'closable',
      send: (snapshot: string) => {
        sent.push(snapshot);
        return blocked.promise;
      },
    });

    consumer.offer('A');
    const closing = consumer.close();
    const secondClose = consumer.close();
    consumer.offer('B');
    expect(consumer.getHealth()).toMatchObject({
      state: 'closing',
      inFlight: true,
      hasPendingLatest: false,
      offered: 1,
    });

    blocked.resolve();
    await Promise.all([closing, secondClose]);
    expect(sent).toEqual(['A']);
    expect(consumer.getHealth()).toMatchObject({ state: 'closed', inFlight: false });
  });

  it('closes after the bounded timeout when an in-flight send never settles', async () => {
    const blocked = deferred();
    const diagnostics: string[] = [];
    const consumer = createLatestWinsConsumer({
      id: 'timeout-close',
      send: () => blocked.promise,
      closeTimeoutMs: 1,
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });

    consumer.offer('A');
    await consumer.close();

    expect(consumer.getHealth()).toMatchObject({
      state: 'closed',
      inFlight: true,
      lastErrorCode: 'close_timeout',
    });
    expect(diagnostics).toEqual(['close_timeout']);
  });
});
