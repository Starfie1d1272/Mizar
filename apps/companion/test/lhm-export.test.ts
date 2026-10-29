import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { expect, it } from 'vitest';
import { HudConfigStore } from '../src/hud-config/store.js';
import { registerHudConfigRoutes } from '../src/hud-config/controller.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';

it('exports the selected active HUD with a guarded revision and no live data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-export-'));
  for (const dir of ['lhm-runtime', 'brand', 'assets/cs2'])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'lhm-runtime/index.html'), '<html></html>');
  await writeFile(join(root, 'brand/test.svg'), '<svg/>');
  await writeFile(join(root, 'assets/cs2/test.png'), 'test');
  const store = new HudConfigStore();
  await store.load();
  const app = Fastify();
  registerHudConfigRoutes(app, {
    store,
    webRoot: root,
    originPolicy: createLocalWebOriginPolicy(),
  });
  const before = store.getState();
  const headers = { origin: 'http://127.0.0.1' };
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/hud-config/export-lhm',
          headers,
          payload: { expectedActiveRevision: 'stale' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/hud-config/export-lhm',
          headers: { origin: 'https://example.com' },
          payload: { expectedActiveRevision: before.activeRevision },
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: '/operator/hud-config/export-lhm',
      headers,
      payload: { expectedActiveRevision: before.activeRevision },
    });
    expect(response.statusCode).toBe(200);
    const files = unzipSync(response.rawPayload);
    expect(JSON.parse(strFromU8(files['mizar-config.json']!))).toEqual(before.resolved);
    expect(JSON.parse(strFromU8(files['hud.json']!))).toMatchObject({
      game: 'cs2',
      name: 'Mizar HUD',
    });
    expect(files['mizar-assets/brand/test.svg']).toBeDefined();
    expect(files['mizar-assets/assets/cs2/test.png']).toBeDefined();
    expect(strFromU8(files['mizar-export-report.json']!)).toContain('team-identity');
    expect(store.getState().activeRevision).toBe(before.activeRevision);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
