import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { expect, it, vi } from 'vitest';

import {
  configuredHttpOutputs,
  createHttpLiveSink,
  createHttpReliableSink,
} from '../src/output/http-sink.js';

async function fixture(name: string): Promise<unknown> {
  const value: unknown = JSON.parse(
    await readFile(resolve(process.cwd(), 'packages/protocol/test/fixtures', name), 'utf8'),
  );
  return value;
}

it.each([
  [204, 'accepted'],
  [302, 'rejected'],
  [400, 'rejected'],
  [401, 'rejected'],
  [409, 'rejected'],
  [408, 'retry'],
  [429, 'retry'],
  [503, 'retry'],
] as const)(
  'maps HTTP %s to %s with scoped auth and stable idempotency',
  async (status, outcome) => {
    const event = parseReliableEventV1(await fixture('reliable-event-v1.json'));
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
    const sink = createHttpReliableSink({
      url: 'https://sink.example/events',
      token: 'scoped-token',
      fetch: request,
    });
    expect(await sink.send(event)).toBe(outcome);
    expect(request).toHaveBeenCalledWith(
      new URL('https://sink.example/events'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify(event),
        headers: {
          authorization: 'Bearer scoped-token',
          'content-type': 'application/json',
          'idempotency-key': event.idempotencyKey,
        },
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  },
);

it('aborts timed out HTTP requests and treats network failure as retry', async () => {
  const event = parseReliableEventV1(await fixture('reliable-event-v1.json'));
  const request = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  vi.useFakeTimers();
  try {
    const send = createHttpReliableSink({
      url: 'https://sink.example/events',
      token: 'token',
      timeoutMs: 100,
      fetch: request,
    }).send(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(await send).toBe('retry');
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  expect(
    await createHttpReliableSink({
      url: 'https://sink.example/events',
      token: 'token',
      fetch: () => Promise.reject(new Error('offline')),
    }).send(event),
  ).toBe('retry');
});

it('posts snapshots without event idempotency and reports failed delivery to the bounded lane', async () => {
  const snapshot = parseLiveSnapshotV1(await fixture('live-snapshot-v1.json'));
  const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
  await createHttpLiveSink({
    url: 'https://sink.example/live',
    token: 'token',
    fetch: request,
  }).send(snapshot);
  expect(request.mock.calls[0]![1]!.headers).not.toHaveProperty('idempotency-key');
  await expect(
    createHttpLiveSink({
      url: 'https://sink.example/live',
      token: 'token',
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    }).send(snapshot),
  ).rejects.toThrow('snapshot_http_delivery_failed');
});

it('wires optional production outputs and rejects incomplete or unsafe configuration', () => {
  expect(configuredHttpOutputs({})).toEqual({});
  expect(
    configuredHttpOutputs({
      MIZAR_OUTPUT_TOKEN: 'token',
      MIZAR_LIVE_OUTPUT_URL: 'https://sink.example/live',
      MIZAR_RELIABLE_OUTPUT_URL: 'https://sink.example/events',
    }),
  ).toHaveProperty('reliableSink.send');
  for (const url of [
    'http://sink.example',
    'https://user:pass@sink.example',
    'https://sink.example/#fragment',
  ]) {
    expect(() =>
      configuredHttpOutputs({ MIZAR_OUTPUT_TOKEN: 'token', MIZAR_RELIABLE_OUTPUT_URL: url }),
    ).toThrow();
  }
  expect(() =>
    configuredHttpOutputs({ MIZAR_RELIABLE_OUTPUT_URL: 'https://sink.example' }),
  ).toThrow();
  expect(() => configuredHttpOutputs({ MIZAR_OUTPUT_TOKEN: 'token' })).toThrow();
});
