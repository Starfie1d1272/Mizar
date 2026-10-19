import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SteamAvatars } from '../src/media/steam-avatars.js';

it('retains avatar load failure stages without logging credential excerpts or rewriting sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-avatar-diagnostic-'));
  const events: { stage: string; evidence: unknown }[] = [];
  const create = () =>
    new SteamAvatars(root, undefined, (stage, evidence) => events.push({ stage, evidence }));
  try {
    await create().load();
    expect(events).toHaveLength(0);
    const secret = '0123456789abcdef0123456789abcdef';
    for (const raw of [
      `{"key":"${secret}" INVALID}`,
      `{"key":"${secret}`,
      `{"key":"${secret}",\nBAD}`,
      `{"key":"${secret}","x": [}`,
    ]) {
      await writeFile(join(root, 'key.json'), raw);
      events.length = 0;
      const avatars = create();
      await avatars.load();
      expect(events[0]).toMatchObject({
        stage: 'key_parse',
        evidence: { error: { name: 'SyntaxError' } },
      });
      expect(avatars.view().unavailable).toBe(true);
      expect(JSON.stringify(events)).not.toContain(secret.slice(0, 8));
      expect(await readFile(join(root, 'key.json'), 'utf8')).toBe(raw);
    }
    await writeFile(join(root, 'key.json'), JSON.stringify({ key: secret }));
    await writeFile(join(root, 'index.json'), '{broken');
    events.length = 0;
    const cache = create();
    await cache.load();
    expect(cache.view().configured).toBe(true);
    expect(events[0]?.stage).toBe('cache_parse');
    expect(JSON.stringify(events)).not.toContain(secret);
    await rm(join(root, 'index.json'));
    await rm(join(root, 'key.json'));
    await mkdir(join(root, 'key.json'));
    events.length = 0;
    await create().load();
    expect(events[0]).toMatchObject({ stage: 'key_read', evidence: { error: { code: 'EISDIR' } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
