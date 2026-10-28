import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceLoadError, createOnlineManifestSource } from '../src/match-context/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

it('never sends a credential to an insecure remote origin or a redirect', async () => {
  expect(() =>
    createOnlineManifestSource('m1', {
      urlTemplate: 'http://example.test/{matchId}',
      readToken: 'secret',
    }),
  ).toThrow();
  const source = createOnlineManifestSource('m1', {
    urlTemplate: 'https://example.test/{matchId}',
    readToken: 'secret',
    fetchImpl: vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { Location: 'https://other.test/' } }),
      ),
    ),
  });
  await expect(source.load()).rejects.toBeInstanceOf(SourceLoadError);
});

it.each(['network', '503'] as const)(
  'backs off bounded %s failures and permits a fresh recovery',
  async (failure) => {
    let clock = 0;
    const waits: number[] = [];
    let failing = true;
    const fetchImpl = vi.fn(() => {
      if (!failing) return Promise.resolve(Response.json({ ok: true }));
      if (failure === 'network') return Promise.reject(new TypeError('fixture network'));
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    const source = createOnlineManifestSource('m1', {
      urlTemplate: 'https://fixture.test/{matchId}',
      readToken: 'fixture-only',
      fetchImpl,
      now: () => clock,
      random: () => 0.5,
      wait: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    await expect(source.load()).rejects.toBeInstanceOf(SourceLoadError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([750, 1500]);
    failing = false;
    await expect(source.load()).resolves.toEqual({ ok: true });
  },
);

it.each(['120', 'Thu, 01 Jan 1970 00:02:00 GMT'])(
  'honors Retry-After %s across later timer calls',
  async (retryAfter) => {
    let clock = 0;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': retryAfter } })),
    );
    const retryState = { notBefore: 0 };
    const config = {
      urlTemplate: 'https://fixture.test/{matchId}',
      readToken: 'fixture-only',
      fetchImpl,
      retryState,
      now: () => clock,
      random: () => 0,
      wait: () => Promise.reject(new Error('must not hold a long request')),
    };
    await expect(createOnlineManifestSource('m1', config).load()).rejects.toBeInstanceOf(
      SourceLoadError,
    );
    clock = 10_000;
    await expect(createOnlineManifestSource('m1', config).load()).rejects.toBeInstanceOf(
      SourceLoadError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = 120_000;
    fetchImpl.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    await expect(createOnlineManifestSource('m1', config).load()).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  },
);

it.each([401, 403, 404, 304])(
  'does not retry HTTP %i or accept a 304 without an entity',
  async (status) => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status })));
    const source = createOnlineManifestSource('m1', {
      urlTemplate: 'https://fixture.test/{matchId}',
      readToken: 'fixture-only',
      fetchImpl,
    });
    await expect(source.load()).rejects.toBeInstanceOf(SourceLoadError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);

it.each([401, 403, 302, 503])(
  'releases rejected HTTP %i bodies even when cancellation rejects or stalls',
  async (status) => {
    const cancel = vi.fn(() =>
      status === 503
        ? new Promise<void>(() => {})
        : Promise.reject(new Error('fixture cancel failure')),
    );
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status });
    const fetchImpl = vi.fn(() => Promise.resolve(response));
    const source = createOnlineManifestSource('m1', {
      urlTemplate: 'https://fixture.test/{matchId}',
      readToken: 'fixture-only',
      fetchImpl,
      retries: 0,
    });
    await expect(source.load()).rejects.toBeInstanceOf(SourceLoadError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);

it('cancels the body when the scope changes as a response arrives', async () => {
  let current = true;
  const cancel = vi.fn();
  const source = createOnlineManifestSource('m1', {
    urlTemplate: 'https://fixture.test/{matchId}',
    readToken: 'fixture-only',
    isCurrent: () => current,
    fetchImpl: vi.fn(() => {
      current = false;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    }),
  });
  await expect(source.load()).rejects.toMatchObject({ code: 'authorization' });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('rechecks a shared longer Retry-After before retrying a different match that already waited', async () => {
  let clock = 0;
  const retryState = { notBefore: 0 };
  const responses: ((response: Response) => void)[] = [];
  const fetchImpl = vi.fn<typeof fetch>(
    () => new Promise<Response>((resolve) => responses.push(resolve)),
  );
  let wake: (() => void) | undefined;
  const waits: number[] = [];
  const config = {
    urlTemplate: 'https://fixture.test/{matchId}',
    readToken: 'fixture-only',
    retryState,
    now: () => clock,
    random: () => 0,
    fetchImpl,
    wait: (ms: number) => {
      waits.push(ms);
      return new Promise<void>((resolve) => {
        wake = resolve;
      });
    },
  };
  const a = createOnlineManifestSource('match-a', config);
  const b = createOnlineManifestSource('match-b', config);
  const readingA = a.load();
  const readingB = b.load();
  const failedA = expect(readingA).rejects.toMatchObject({ status: 429 });
  const failedB = expect(readingB).rejects.toMatchObject({ status: 429 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  responses[0]!(new Response(null, { status: 429, headers: { 'retry-after': '2' } }));
  await vi.waitFor(() => expect(waits).toEqual([2000]));
  responses[1]!(new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
  await failedB;
  expect(retryState.notBefore).toBe(60_000);
  clock = 2000;
  wake!();
  await failedA;
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(waits).toEqual([2000]);
  clock = 60_000;
  fetchImpl.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
  await expect(a.load()).resolves.toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
