import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkspaceObserver } from '../src/telemetry/observer-workspace.js';
import { createObserverSourceManager } from '../src/telemetry/cstv-source-manager.js';

it('maps embedded clock generations after replacing a real source manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-workspace-generation-'));
  const initial = createObserverSourceManager({
    role: 'lookahead',
    identity: { source: 'ahead:initial', role: 'ahead', channel: 1, world: 1 },
  });
  initial.start();
  initial.disconnectObserver();
  let attempt = 0;
  const observer = new WorkspaceObserver(
    async () => ({
      role: 'lookahead',
      python: process.execPath,
      driver: resolve('apps/companion/test/fixtures/observer-child.mjs'),
      native: process.execPath,
      steamApi: process.execPath,
      node: process.execPath,
      parserWorker: process.execPath,
      outputDirectory: join(root, `attempt-${++attempt}`),
      hostVersion: 14191,
    }),
    initial,
  );
  const assertClock = async () => {
    await vi.waitFor(
      () => {
        const health = observer.source.getHealth();
        expect(health.roundClock).toBeDefined();
        expect(health.freezeEnd).toBeDefined();
        expect(health.roundClock?.generation).toBe(health.generation);
        expect(health.freezeEnd?.generation).toBe(health.generation);
        expect(observer.source.getSnapshot().health).toEqual(health);
      },
      { timeout: 5000, interval: 20 },
    );
    return observer.source.getHealth();
  };
  try {
    await observer.start(process.execPath, '127.0.0.25:27020', '');
    const first = await assertClock();
    await observer.start(process.execPath, '127.0.0.25:27020', '');
    const second = await assertClock();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.clockExecution).toBe(0);
  } finally {
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});
