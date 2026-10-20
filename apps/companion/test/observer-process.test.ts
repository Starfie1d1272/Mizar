import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startObserverProcess } from '../src/telemetry/observer-process.js';
const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
const options = {
  role: 'lookahead' as const,
  python: process.execPath,
  driver,
  native: driver,
  steamApi: driver,
  node: process.execPath,
  parserWorker: driver,
  outputDirectory: driver + '.unused',
  hostVersion: 14191,
  endpoint: '127.0.0.1:27020',
  password: 'synthetic-only',
};
describe('explicit observer process composition', () => {
  it('reads the owned child and stops it without late delivery', async () => {
    const processOwner = startObserverProcess(options);
    try {
      await expect.poll(() => processOwner.manager.getRecentGameEvents().length).toBe(1);
      expect(processOwner.manager.getHealth().state).toBe('live');
      expect(processOwner.manager.getRecentGameEvents()[0]?.cursor.role).toBe('lookahead');
      expect(await processOwner.stop()).toEqual({ exited: true });
      expect(await processOwner.closed).toMatchObject({ cancelled: true, failed: false, code: 2 });
      expect(processOwner.manager.getHealth().state).toBe('stopped');
    } finally {
      await processOwner.stop();
    }
  });
  it('surfaces child failure without retaining input or stderr', async () => {
    const processOwner = startObserverProcess({ ...options, endpoint: '127.0.0.2:27020' });
    try {
      const result = await processOwner.closed;
      expect(result.failed).toBe(true);
      expect(result.code).toBe(7);
      expect(JSON.stringify(result)).not.toContain(options.password);
      expect(processOwner.manager.getHealth().state).toBe('reconnecting');
    } finally {
      await processOwner.stop();
    }
  });
  it.each(['127.0.0.3:27020', '127.0.0.4:27020'])(
    'fails closed without readiness for %s',
    async (endpoint) => {
      const processOwner = startObserverProcess({ ...options, endpoint });
      try {
        expect(await processOwner.closed).toMatchObject({ failed: true, ready: false });
      } finally {
        expect(await processOwner.stop()).toEqual({ exited: true });
      }
    },
  );
  it('bounds startup readiness without claiming a live source', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const processOwner = startObserverProcess(options);
    try {
      vi.advanceTimersByTime(30_000);
      expect(await processOwner.closed).toMatchObject({
        failed: true,
        ready: false,
        startupTimedOut: true,
      });
    } finally {
      vi.useRealTimers();
      await processOwner.stop();
    }
  });
  it('rejects unbounded or unsupported connection data before launch', () => {
    expect(() => startObserverProcess({ ...options, password: 'x'.repeat(96) })).toThrow(
      'Invalid observer launch configuration',
    );
    expect(() => startObserverProcess({ ...options, endpoint: 'example.com:27020' })).toThrow();
    expect(() => startObserverProcess({ ...options, hostVersion: 14192 })).toThrow();
  });
});
