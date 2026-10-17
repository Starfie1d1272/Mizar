import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { SessionJournal } from '../src/support/session-journal.js';
import { DiagnosticDelivery } from '../src/support/delivery.js';
import { registerDiagnosticDelivery } from '../src/support/delivery-routes.js';
import { buildApp } from '../src/app.js';
const roots: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((v) => v.close()));
  await Promise.all(roots.splice(0).map((v) => rm(v, { recursive: true, force: true })));
});
const headers = { origin: 'http://127.0.0.1:3000' };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-delivery-routes-'));
  roots.push(directory);
  const app = buildApp({ supportLogsDirectory: directory });
  apps.push(app);
  await app.ready();
  for (let i = 0; i < 100; i++) {
    const response = await app.inject({ url: '/local/v1/diagnostics/delivery', headers });
    if (response.json<{ available: boolean }>().available) return { app, directory };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('queue initialization timed out');
}
it('requires loopback origin and explicit current consent; pauses without clearing and records a problem locally without claiming receipt', async () => {
  const { app, directory } = await setup();
  expect(
    (
      await app.inject({
        url: '/local/v1/diagnostics/delivery',
        headers: { 'sec-fetch-site': 'same-origin' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: '/local/v1/diagnostics/delivery',
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: '/local/v1/diagnostics/delivery', headers })).json(),
  ).toMatchObject({ available: true, configured: false, consent: false });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        payload: { enabled: true, revision: 'technical-diagnostics-v2' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: true },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: true, revision: 'technical-diagnostics-v2' },
      })
    ).statusCode,
  ).toBe(503);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: true, revision: 'technical-diagnostics-v1' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: false, revision: 'technical-diagnostics-v1' },
      })
    ).statusCode,
  ).toBe(200);
  const report = await app.inject({
    method: 'POST',
    url: '/operator/diagnostics/report',
    headers,
    payload: { category: 'hud', observedAt: new Date().toISOString() },
  });
  expect(report.json()).toMatchObject({
    recorded: true,
    cloud: { configured: false, acknowledged: 0 },
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/pause',
        headers,
        payload: { paused: true },
      })
    ).json(),
  ).toMatchObject({ consent: false, paused: true });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: false, revision: 'technical-diagnostics-v2' },
      })
    ).json(),
  ).toMatchObject({ consent: false, deletionPending: 0 });
  const lines = (await readFile(join(directory, 'session.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((v) => JSON.parse(v) as { stage: string; evidence: unknown });
  expect(lines.find((v) => v.stage === 'problem_report')?.evidence).toMatchObject({
    category: 'hud',
    upload: 'local_only',
  });
  expect(lines.find((v) => v.stage === 'runtime_performance_window')?.evidence).toMatchObject({
    reason: 'problem_report',
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/report',
        headers,
        payload: { category: 'hud', observedAt: '2000-01-01T00:00:00Z' },
      })
    ).statusCode,
  ).toBe(400);
});
it('keeps normal service usable when diagnostics directory cannot initialize', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-delivery-unavailable-'));
  roots.push(directory);
  const app = buildApp();
  apps.push(app);
  await app.ready();
  expect((await app.inject('/health')).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: true, revision: 'technical-diagnostics-v2' },
      })
    ).statusCode,
  ).toBe(503);
});

it('preserves the original pause exception chain instead of only returning a generic 503', async () => {
  const { app, directory } = await setup();
  const cause = Object.assign(new Error('state rename denied'), { code: 'EACCES' });
  vi.spyOn(DiagnosticDelivery.prototype, 'pause').mockRejectedValueOnce(
    new Error('cannot save pause', { cause }),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/operator/diagnostics/pause',
    headers,
    payload: { paused: true },
  });
  expect(response.statusCode).toBe(503);
  await app.close();
  const text = await readFile(join(directory, 'session.ndjson'), 'utf8');
  expect(text).toContain('cannot save pause');
  expect(text).toContain('state rename denied');
  expect(text).toContain('EACCES');
});
it('does not acknowledge a marker after the source journal closes or the delivery module starts shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-marker-shutdown-'));
  roots.push(directory);
  const journal = new SessionJournal(directory);
  const app = Fastify();
  apps.push(app);
  const service = registerDiagnosticDelivery(app, {
    directory,
    journal,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
  });
  await app.ready();
  await journal.close();
  const body = { category: 'hud', observedAt: new Date().toISOString() };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/report',
        headers,
        payload: body,
      })
    ).statusCode,
  ).toBe(503);
  await service.close();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/report',
        headers,
        payload: body,
      })
    ).statusCode,
  ).toBe(503);
  const text = await readFile(join(directory, 'session.ndjson'), 'utf8');
  expect(text).not.toContain('problem_report');
});

it('finishes an admitted marker commit before app shutdown and never returns success for a failed write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-marker-commit-'));
  roots.push(directory);
  const journal = new SessionJournal(directory);
  await journal.flush();
  const app = Fastify();
  apps.push(app);
  const service = registerDiagnosticDelivery(app, {
    directory,
    journal,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
  });
  app.addHook('onClose', async () => {
    await journal.close();
    await service.close();
  });
  await app.ready();
  const internal = journal as unknown as {
    append(line: string, bytes: number, sync?: boolean): Promise<void>;
  };
  const append = internal.append.bind(journal);
  const spy = vi.spyOn(internal, 'append');
  spy.mockRejectedValueOnce(
    new Error('injected marker storage failure', { cause: new Error('ENOSPC') }),
  );
  const body = { category: 'hud', observedAt: new Date().toISOString() };
  const failed = await app.inject({
    method: 'POST',
    url: '/operator/diagnostics/report',
    headers,
    payload: body,
  });
  expect(failed.statusCode).toBe(503);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  spy
    .mockImplementationOnce(async (...args) => {
      entered();
      await barrier;
      await append(...args);
    })
    .mockImplementation(append);
  const request = app.inject({
    method: 'POST',
    url: '/operator/diagnostics/report',
    headers,
    payload: body,
  });
  const responsePromise = request.then((response) => response);
  await started;
  const closing = app.close();
  release();
  const response = await responsePromise;
  await closing;
  expect(response.statusCode).toBe(200);
  const receipt = response.json<{ recorded: boolean; sequence: number }>();
  expect(receipt.recorded).toBe(true);
  const records = (await readFile(join(directory, 'session.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { stage: string; sequence: number });
  expect(records.filter((record) => record.stage === 'problem_report')).toEqual([
    expect.objectContaining({ sequence: receipt.sequence }),
  ]);
  expect(records.at(-1)?.stage).toBe('session_end');
});
