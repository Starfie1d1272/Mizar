import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { SteamAvatars, registerSteamAvatarRoutes } from '../src/media/steam-avatars.js';

describe('optional local Steam media', () => {
  it('batches only observed IDs, caches media across restart and never returns the key or names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-steam-'));
    const ids = ['76561198000000001', '76561198000000002'];
    const key = '1234567890abcdef1234567890abcdef';
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Promise.resolve(
        url.hostname === 'api.steampowered.com'
          ? Response.json({
              response: {
                players: ids.map((steamid) => ({
                  steamid,
                  personaname: 'ignored-name',
                  avatarfull: `https://avatars.steamstatic.com/${steamid}.jpg`,
                })),
              },
            })
          : new Response(Buffer.from([255, 216, 1, 2, 255, 217])),
      );
    });
    const avatars = new SteamAvatars(directory, fetchImpl);
    const app = Fastify();
    registerSteamAvatarRoutes(app, avatars, {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000'],
    });
    try {
      await avatars.configure(key);
      const changed = new Promise<void>((resolve) => avatars.onChanged(resolve));
      avatars.request([...ids, 'bad-id']);
      await changed;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(new URL(fetchImpl.mock.calls[0]![0] as URL).searchParams.get('steamids')).toBe(
        ids.join(','),
      );
      expect(avatars.get(ids[0]!)).toMatch(/^\/local\/v1\/steam-avatar\/[a-f0-9]{64}\.jpg$/);
      const status = await app.inject('/local/v1/steam-avatars');
      expect(status.json()).toMatchObject({ configured: true, cached: 2 });
      expect(status.body).not.toContain(key);
      expect(await readFile(join(directory, 'index.json'), 'utf8')).not.toContain('ignored-name');
      const restarted = new SteamAvatars(directory, fetchImpl);
      await restarted.load();
      expect(restarted.get(ids[0]!)).toBe(avatars.get(ids[0]!));
      restarted.request(ids);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      await restarted.configure('');
      expect(restarted.get(ids[0]!)).not.toBeNull();
      await restarted.clear();
      expect(restarted.get(ids[0]!)).toBeNull();
      restarted.close();
    } finally {
      avatars.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects foreign origins and cannot fetch arbitrary avatar hosts or redirects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-steam-'));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        response: {
          players: [{ steamid: '76561198000000001', avatarfull: 'https://127.0.0.1/private.jpg' }],
        },
      }),
    );
    const avatars = new SteamAvatars(directory, fetchImpl);
    const app = Fastify();
    registerSteamAvatarRoutes(app, avatars, {
      mode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000'],
    });
    try {
      const rejected = await app.inject({
        method: 'POST',
        url: '/operator/steam-avatars',
        headers: { origin: 'https://foreign.example' },
        payload: { action: 'configure', key: 'a'.repeat(32) },
      });
      expect(rejected.statusCode).toBe(403);
      await avatars.configure('a'.repeat(32));
      const changed = new Promise<void>((resolve) => avatars.onChanged(resolve));
      avatars.request(['76561198000000001']);
      await changed;
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(avatars.get('76561198000000001')).toBeNull();
      expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe('error');
    } finally {
      avatars.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
