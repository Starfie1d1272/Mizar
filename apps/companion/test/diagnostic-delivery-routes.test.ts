import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
const roots: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
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
        payload: { enabled: true, revision: 'technical-diagnostics-v1' },
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
        payload: { enabled: true, revision: 'technical-diagnostics-v1' },
      })
    ).json(),
  ).toMatchObject({ consent: true });
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
  ).toMatchObject({ consent: true, paused: true });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operator/diagnostics/consent',
        headers,
        payload: { enabled: false, revision: 'technical-diagnostics-v1' },
      })
    ).json(),
  ).toMatchObject({ consent: false, deletionPending: 0 });
  const lines = (await readFile(join(directory, 'session.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((v) => JSON.parse(v) as { stage: string; evidence: unknown });
  expect(lines.find((v) => v.stage === 'problem_report')?.evidence).toMatchObject({
    category: 'hud',
    upload: 'queued_when_capacity_available',
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
        payload: { enabled: true, revision: 'technical-diagnostics-v1' },
      })
    ).statusCode,
  ).toBe(503);
});
