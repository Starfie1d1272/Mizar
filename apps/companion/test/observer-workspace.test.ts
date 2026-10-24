import { ObserverSettingsStore } from '../src/telemetry/observer-settings.js';
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
  it('reports output failure after joining the child and permits a fresh connection', () =>
    fixture(async (observer) => {
      await observer.start(driver, '127.0.0.3:27020', 'synthetic-only');
      await expect.poll(() => observer.view().active).toBe(false);
      expect(observer.view().failed).toBe(true);
      await observer.start(driver, '127.0.0.1:27020', 'synthetic-only');
      await expect.poll(() => observer.source.getHealth().state).toBe('live');
      expect(observer.view().failed).toBe(false);
    }));
  it('keeps connection preparation within production eligibility', () =>
    fixture(async (observer) => {
      const app = Fastify();
      registerWorkspaceObserver(app, observer, 'synthetic-capability', () => false);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/operator/runtime/observer',
          headers: { 'x-runtime-token': 'synthetic-capability' },
          payload: {
            action: 'start',
            executable: driver,
            job: 'Local\\MizarObserver-test',
            endpoint: '127.0.0.1:27020',
            password: 'synthetic-only',
          },
        });
        expect(response.statusCode).toBe(409);
        expect(observer.view().active).toBe(false);
      } finally {
        await app.close();
      }
    }));
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

it('rechecks the enabled configuration after waiting for an earlier observer to stop', () =>
  fixture(async (observer) => {
    const app = Fastify(),
      settings = new ObserverSettingsStore();
    await settings.configure({ ...settings.settings, enabled: true, hideGameHud: false });
    settings.setConnection({
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'synthetic',
    });
    registerWorkspaceObserver(app, observer, 'synthetic-capability', () => true, settings);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped = vi.spyOn(observer, 'stop').mockImplementationOnce(() => gate);
    const start = vi.spyOn(observer, 'start');
    try {
      const pending = app
        .inject({
          method: 'POST',
          url: '/operator/runtime/observer',
          headers: { 'x-runtime-token': 'synthetic-capability' },
          payload: {
            action: 'start-configured',
            executable: driver,
            game: '42-1',
            job: 'Local\\MizarObserver-test',
            revision: settings.revision,
          },
        })
        .then((response) => response);
      await expect.poll(() => stopped.mock.calls.length).toBe(1);
      await settings.configure({ ...settings.settings, enabled: false });
      release();
      expect((await pending).statusCode).toBe(409);
      expect(start).not.toHaveBeenCalled();
    } finally {
      release();
      await app.close();
    }
  }));
