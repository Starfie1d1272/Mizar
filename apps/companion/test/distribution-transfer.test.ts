import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { transfer } from '../src/distribution/transfer.js';

it('retries corrupt remote bytes but never overwrites a local file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-transfer-'));
  const target = join(directory, 'archive');
  const bytes = Buffer.from('good');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let fallback = 0;
  try {
    await transfer({
      target,
      bytes: bytes.length,
      sha256,
      signal: new AbortController().signal,
      sources: [async () => new Response('evil'), async () => new Response(bytes)],
      fallback: () => {
        fallback++;
      },
    });
    expect(await readFile(target)).toEqual(bytes);
    expect(fallback).toBe(1);
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
