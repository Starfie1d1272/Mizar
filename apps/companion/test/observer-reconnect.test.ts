import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startObserverProcess } from '../src/telemetry/observer-process.js';

const fixture = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
async function run(endpoint: string) {
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
  });
  return {
    owner,
    output,
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
      const test = await run(endpoint);
      try {
        await expect.poll(() => test.owner.manager.getHealth().state).toBe('reconnecting');
        expect(test.owner.manager.getRecentGameEvents()).toEqual([]);
        const generation = test.owner.manager.getHealth().generation;
        await expect
          .poll(() => test.owner.manager.getHealth().state, { timeout: 5000 })
          .toBe('live');
        expect(test.owner.manager.getHealth().generation).toBeGreaterThan(generation);
        expect(test.owner.manager.getRecentGameEvents()).toHaveLength(1);
        const old = JSON.parse(await readFile(join(test.output, 'child.json'), 'utf8')) as {
          source: string;
          pid: number;
        };
        const next = JSON.parse(
          await readFile(join(test.output, 'retry-2', 'child.json'), 'utf8'),
        ) as { source: string; pid: number };
        expect(next.source).not.toBe(old.source);
        expect(() => process.kill(old.pid, 0)).toThrow();
        await test.owner.stop();
        expect(await test.owner.closed).toMatchObject({
          attemptCount: 2,
          cancelled: true,
          failed: false,
        });
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
      await expect(readFile(join(test.output, 'retry-2', 'child.json'))).rejects.toThrow();
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
      await expect(readFile(join(test.output, 'retry-2', 'child.json'))).rejects.toThrow();
    } finally {
      await test.cleanup();
    }
  });
});
