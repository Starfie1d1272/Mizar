import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { MusicConfig } from '@mizar/protocol/music';
import { MusicStore, type MusicConfigPersistence } from '../../src/music/store.js';

it('keeps playback state local while the coordinator owns music config across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'broadcast-music-'));
  try {
    const store = new MusicStore(directory);
    await store.load();
    const legacy = await readFile(join(directory, 'state.json'), 'utf8');
    let saved = {
      config: structuredClone(store.state.config),
      revision: store.state.configRevision,
    };
    const owner: MusicConfigPersistence = {
      initialize: () => Promise.resolve(saved),
      read: () => Promise.resolve(saved),
      commit: (config: MusicConfig) => {
        saved = { config: structuredClone(config), revision: randomUUID() };
        return Promise.resolve(saved);
      },
    };
    await store.adoptPersistence(owner);
    await store.update((state) => {
      state.config.groups.waiting.volume = 0.2;
    });
    await store.update((state) => {
      state.master = 0.3;
      state.muted = true;
    });
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe(legacy);
    const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(runtime).not.toHaveProperty('config');
    expect(runtime).not.toHaveProperty('configRevision');
    const reopened = new MusicStore(directory);
    await reopened.loadWithPersistence(owner);
    expect(reopened.state.config.groups.waiting.volume).toBe(0.2);
    expect(reopened.state.master).toBe(0.3);
    expect(reopened.state.muted).toBe(true);
    await expect(
      reopened.update((state) => {
        state.master = 0.5;
        state.config.groups.waiting.volume = 0.4;
      }),
    ).rejects.toThrow('music_mixed_update');
    expect(saved.config.groups.waiting.volume).toBe(0.2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
