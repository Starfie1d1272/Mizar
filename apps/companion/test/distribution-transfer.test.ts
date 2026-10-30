import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { transfer } from '../src/distribution/transfer.js';

it('retries corrupt remote bytes but never overwrites a local file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-transfer-'));
  const target = join(directory, 'archive');
  const bytes = Buffer.from('good');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let fallback = 0;
  const verifying = vi.fn();
  try {
    await transfer({
      target,
      bytes: bytes.length,
      sha256,
      signal: new AbortController().signal,
      sources: [async () => new Response('evil'), async () => new Response(bytes)],
      verifying,
      fallback: () => {
        fallback++;
      },
    });
    expect(await readFile(target)).toEqual(bytes);
    expect(fallback).toBe(1);
    expect(verifying).toHaveBeenCalledTimes(2);
    await writeFile(target, 'original');
    await expect(
      transfer({
        target,
        bytes: bytes.length,
        sha256,
        signal: new AbortController().signal,
        sources: [
          async () => new Response(bytes),
          async () => {
            throw new Error('must not retry');
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(target, 'utf8')).toBe('original');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('cleans up and does not switch sources after cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-transfer-'));
  const target = join(directory, 'archive');
  const bytes = Buffer.from('good');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const abort = new AbortController();
  let fallbacks = 0;
  const stalled = async (signal: AbortSignal) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
    );
  try {
    const cancelled = transfer({
      target,
      bytes: bytes.length,
      sha256,
      signal: abort.signal,
      sources: [
        stalled,
        async () => {
          fallbacks++;
          return new Response(bytes);
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    await expect(cancelled).rejects.toThrow();
    expect(fallbacks).toBe(0);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('switches after the first-byte and idle budgets and resets source progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-transfer-'));
  const target = join(directory, 'archive');
  const bytes = Buffer.from('good');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  vi.useFakeTimers();
  try {
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = transfer({
      target,
      bytes: bytes.length,
      sha256,
      signal: new AbortController().signal,
      sources: [
        (signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            started();
          }),
        async () => new Response(bytes),
      ],
    });
    await requested;
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    await rm(target);
    let advanced!: () => void;
    const received = new Promise<void>((resolve) => {
      advanced = resolve;
    });
    const progress: Array<[number, number]> = [];
    const second = transfer({
      target,
      bytes: bytes.length,
      sha256,
      signal: new AbortController().signal,
      sources: [
        async (signal) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 1));
                signal.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true,
                });
              },
            }),
          ),
        async () => new Response(bytes),
      ],
      progress: (count, source) => {
        progress.push([count, source]);
        if (count === 1) advanced();
      },
    });
    await received;
    await vi.advanceTimersByTimeAsync(30_000);
    await second;
    expect(progress).toContainEqual([0, 1]);
    expect(await readFile(target)).toEqual(bytes);
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});
