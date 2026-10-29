import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { expect, it } from 'vitest';
import { startLhmHost } from '../src/hud-compat/host.js';

const programFixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: { payload: unknown } }> };
const radarFixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { samples: { snapshot: { payload: unknown } }[] }> };

it('registers and re-registers the instance with current config and projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-lhm-'));
  await writeFile(join(root, 'index.html'), 'sample');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const bundle = {
    program: programFixtures.fixtures['real-warmup']!.snapshot.payload,
    radar: radarFixtures.fixtures.warmup!.samples[0]!.snapshot.payload,
  };
  const projections = {
    getCurrent: () => bundle,
    subscribePresentation: (listener: (value: typeof bundle) => void) => {
      listener(bundle);
      return () => {};
    },
  } as never;
  const host = await startLhmHost({
    root,
    port,
    projections,
    config: { display_settings: { left_title: 'test' } },
  });
  const socket = io(`http://127.0.0.1:${port}`, { autoConnect: false });
  const register = () =>
    new Promise<{ config: unknown; update: unknown }>((resolve) => {
      let config: unknown;
      socket.once('readyToRegister', () =>
        socket.emit('register', 'mizar', false, 'cs2', 'DEFAULT'),
      );
      socket.once('hud_config', (value) => {
        config = value;
      });
      socket.once('update', (value) => resolve({ config, update: value }));
      socket.connect();
    });
  try {
    expect(await register()).toMatchObject({
      config: { display_settings: { left_title: 'test' } },
      update: { map: { name: 'de_ancient' } },
    });
    socket.disconnect();
    expect(await register()).toMatchObject({ update: { map: { name: 'de_ancient' } } });
    const response = await fetch(host.url);
    expect(await response.text()).toBe('sample');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect((await fetch(`http://127.0.0.1:${port}/operator`)).status).toBe(404);
  } finally {
    socket.disconnect();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
