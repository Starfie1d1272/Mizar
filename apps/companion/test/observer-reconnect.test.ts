import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startObserverProcess } from '../src/telemetry/observer-process.js';

const fixture = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
async function run(endpoint: string, onAttempt?: () => void) {
  const temp = await mkdtemp(join(tmpdir(), 'mizar-observer-reconnect-'));
  const output = join(temp, 'source');
  const owner = startObserverProcess({
    role: 'lookahead',
    python: process.execPath,
    driver: fixture,
    native: fixture,
    steamApi: fixture,
    node: process.execPath,
    parserWorker: fixture,
    outputDirectory: output,
    hostVersion: 14192,
    endpoint,
    password: 'synthetic-private-password',
    ...(onAttempt ? { onAttempt } : {}),
  });
  return {
    owner,
    output,
    retryDirectory: async () =>
      join(
        temp,
        (await readdir(temp)).find((name) => name.startsWith('retry-2-')) ?? 'missing-retry',
      ),
    async cleanup() {
      await owner.stop();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

describe('observer reconnection through real owned child processes', () => {
  it.each(['127.0.0.6:27020', '127.0.0.7:27020'])(
    'recovers %s with a new owner identity and no stale events',
    async (endpoint) => {
      const test = await run(endpoint, () => {
        throw new Error('diagnostic-subscriber-secret');
      });
      try {
        await expect.poll(() => test.owner.manager.getHealth().state).toBe('reconnecting');
        expect(test.owner.manager.getRecentGameEvents()).toEqual([]);
        const generation = test.owner.manager.getHealth().generation;
        await expect
          .poll(() => test.owner.manager.getHealth().state, { timeout: 5000 })
          .toBe('live');
        expect(test.owner.manager.getHealth().generation).toBeGreaterThan(generation);
        await expect.poll(() => test.owner.manager.getRecentGameEvents().length).toBe(1);
        const old = JSON.parse(await readFile(join(test.output, 'child.json'), 'utf8')) as {
          source: string;
          pid: number;
        };
        const next = JSON.parse(
          await readFile(join(await test.retryDirectory(), 'child.json'), 'utf8'),
        ) as { source: string; pid: number };
        expect(next.source).not.toBe(old.source);
        expect(() => process.kill(old.pid, 0)).toThrow();
        await test.owner.stop();
        expect(await test.owner.closed).toMatchObject({
          attemptCount: 2,
          cancelled: true,
          failed: false,
        });
        const attempts = (await test.owner.closed).attempts;
        expect(attempts.map((attempt) => attempt.attemptCount)).toEqual([1, 2]);
        expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
        expect(attempts[0]!.reason).toBe(
          endpoint === '127.0.0.6:27020' ? 'native-session-closed' : 'initialization-timeout',
        );
        expect(attempts[1]).toMatchObject({ cancelled: true, ready: true });
        expect(test.owner.source.getHealth().state).toBe('stopped');
        expect(() => process.kill(next.pid, 0)).toThrow();
      } finally {
        await test.cleanup();
      }
    },
  );

  it('cancels during backoff without spawning another child', async () => {
    const test = await run('127.0.0.8:27020');
    try {
      await expect.poll(() => test.owner.manager.getHealth().state).toBe('reconnecting');
      await test.owner.source.stop();
      expect(await test.owner.closed).toMatchObject({
        attemptCount: 1,
        cancelled: true,
        failed: false,
      });
      await expect(readFile(join(await test.retryDirectory(), 'child.json'))).rejects.toThrow();
    } finally {
      await test.cleanup();
    }
  });

  it.each([
    ['127.0.0.9:27020', true],
    ['127.0.0.10:27020', false],
  ] as const)('does not retry a rejection or normal match end: %s', async (endpoint, failed) => {
    const test = await run(endpoint);
    try {
      expect(await test.owner.closed).toMatchObject({ attemptCount: 1, failed });
      expect(test.owner.source.getRecentGameEvents()).toEqual([]);
      await expect(readFile(join(await test.retryDirectory(), 'child.json'))).rejects.toThrow();
    } finally {
      await test.cleanup();
    }
  });
});

it('retries beside the first leaf when a real owned child times out before mkdir', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const test = await run('127.0.0.20:27020');
  const wait = async (predicate: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await delay(10);
    }
    throw new Error('real child did not reach the expected boundary');
  };
  try {
    const marker = join(dirname(test.output), 'pre-mkdir.json');
    await wait(async () =>
      readFile(marker).then(
        () => true,
        () => false,
      ),
    );
    const first = JSON.parse(await readFile(marker, 'utf8')) as { pid: number };
    await expect(readFile(join(test.output, 'child.json'))).rejects.toThrow();
    expect((await readdir(dirname(test.output))).includes('source')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await wait(() => test.owner.attempts().length === 1);
    expect(test.owner.attempts()[0]).toMatchObject({
      stage: 'readiness-timeout',
      startupTimedOut: true,
      ready: false,
    });
    expect(() => process.kill(first.pid, 0)).toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await wait(() => test.owner.manager.getHealth().state === 'live');
    const retry = await test.retryDirectory();
    expect(dirname(retry)).toBe(dirname(test.output));
    expect((await readdir(dirname(test.output))).includes('source')).toBe(false);
    expect(await readFile(join(retry, 'child.json'), 'utf8')).toBeTruthy();
    vi.useRealTimers();
    await test.owner.stop();
    expect(await test.owner.closed).toMatchObject({
      attemptCount: 2,
      cancelled: true,
      failed: false,
    });
  } finally {
    vi.useRealTimers();
    await test.cleanup();
  }
});
