import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import {
  WorkspaceObserver,
  registerWorkspaceObserver,
} from '../src/telemetry/observer-workspace.js';

const driver = fileURLToPath(new URL('./fixtures/observer-child.mjs', import.meta.url));
async function fixture(run: (observer: WorkspaceObserver, app: FastifyInstance) => Promise<void>) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'mizar-observer-workspace-'));
  const observer = new WorkspaceObserver(() =>
    Promise.resolve({
      role: 'lookahead',
      python: process.execPath,
      node: process.execPath,
      driver,
      native: driver,
      steamApi: driver,
      parserWorker: driver,
      hostVersion: 14192,
      outputDirectory,
    }),
  );
  const app = Fastify();
  registerWorkspaceObserver(app, observer, 'synthetic-capability');
  try {
    await run(observer, app);
  } finally {
    await observer.close();
    await app.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
describe('workbench observer ownership', () => {
  it('starts, delivers privately, stops and starts a fresh source through native commands', () =>
    fixture(async (observer, app) => {
      const events: unknown[] = [];
      observer.source.subscribeLiveGameEvents((event) => events.push(event));
      const headers = { 'x-runtime-token': 'synthetic-capability' };
      const payload = {
        action: 'start',
        executable: driver,
        job: 'Local\\MizarObserver-test',
        endpoint: '127.0.0.1:27020',
        password: 'synthetic-only',
      };
      expect(
        (await app.inject({ method: 'POST', url: '/operator/runtime/observer', headers, payload }))
          .statusCode,
      ).toBe(200);
      await expect.poll(() => observer.source.getRecentGameEvents().length).toBe(1);
      expect(observer.source.getHealth().role).toBe('lookahead');
      const first = observer.source.getRecentGameEvents()[0]!.cursor.generation;
      expect(events).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/operator/runtime/observer',
            headers,
            payload: { action: 'stop' },
          })
        ).statusCode,
      ).toBe(200);
      expect(observer.view().active).toBe(false);
      expect(observer.source.getHealth().state).toBe('stopped');
      expect(
        (await app.inject({ method: 'POST', url: '/operator/runtime/observer', headers, payload }))
          .statusCode,
      ).toBe(200);
      await expect.poll(() => observer.source.getRecentGameEvents().length).toBe(1);
      expect(observer.source.getRecentGameEvents()[0]!.cursor.generation).toBeGreaterThan(first);
      expect(events).toHaveLength(2);
      expect(
        JSON.stringify((await app.inject({ url: '/local/v1/observer' })).json()),
      ).not.toContain('synthetic-only');
    }));
  it('requires the private host capability and a native request origin', () =>
    fixture(async (observer, app) => {
      for (const headers of [
        {},
        { 'x-runtime-token': 'synthetic-capability', origin: 'http://127.0.0.1:3000' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/operator/runtime/observer',
              headers,
              payload: { action: 'stop' },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(observer.view().active).toBe(false);
    }));
  it('expires a missing game/host heartbeat and joins the owned process', () =>
    fixture(async (observer) => {
      await observer.start(driver, '127.0.0.1:27020', 'synthetic-only');
      await expect.poll(() => observer.source.getHealth().state).toBe('live');
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10_000);
      try {
        await expect.poll(() => observer.view().active, { timeout: 4000 }).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
      expect(observer.source.getHealth().state).toBe('stopped');
    }));
});
