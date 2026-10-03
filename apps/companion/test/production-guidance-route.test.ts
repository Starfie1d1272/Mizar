import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { toMatchContext, validateBroadcastManifest } from '@mizar/rivalhub';
import { buildApp } from '../src/app.js';

it('exposes current production guidance without changing production or returning credentials', async () => {
  const manifest = validateBroadcastManifest(
    JSON.parse(
      await readFile('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json', 'utf8'),
    ),
  );
  if (!manifest.ok) throw new Error('invalid test fixture');
  const value = { ...manifest.value, commentators: [] };
  const app = buildApp({
    matchContextBinding: {
      manifest: value,
      context: toMatchContext(value),
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
  });
  try {
    await app.ready();
    const before = (await app.inject('/local/v1/production')).body;
    const response = await app.inject('/local/v1/production-guidance');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      matchId: value.match.matchId,
      broadcastAssigned: false,
      bilibili: 'unconfigured',
    });
    const link = new URL(response.json<{ rivalhubUrl: string }>().rivalhubUrl);
    expect(link.origin).toBe('https://match.starfie1d.top');
    expect(link.search).toBe('');
    expect(link.username).toBe('');
    expect((await app.inject('/local/v1/production')).body).toBe(before);
  } finally {
    await app.close();
  }
});
