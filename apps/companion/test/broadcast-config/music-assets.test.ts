import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMusicConfig } from '@mizar/protocol/music';
import { MusicStore } from '../../src/music/store.js';
import {
  musicAssetRef,
  portableMusicConfig,
  portableMusicTrack,
  readMusicAsset,
} from '../../src/broadcast-config/music-assets.js';

describe('music asset migration', () => {
  it('preserves track settings and verifies the content identity without activating it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-music-'));
    try {
      const store = new MusicStore(directory);
      await store.load();
      const bytes = Buffer.from('RIFF0000WAVEtest');
      const added = await store.add('opening.wav', bytes);
      const config = defaultMusicConfig();
      config.groups.waiting.tracks = [{ ...added, startMs: 10, endMs: 100, gain: 0.4 }];
      const portable = await portableMusicConfig(store, config, true);
      const track = portable.groups.waiting.tracks[0]!;
      expect(track).toMatchObject({
        name: 'opening.wav',
        startMs: 10,
        endMs: 100,
        gain: 0.4,
        asset: musicAssetRef(added.id),
      });
      expect(await readMusicAsset(store, track.asset)).toEqual(bytes);
      expect((await portableMusicTrack(store, added)).asset).toEqual(track.asset);
      await expect(
        readMusicAsset(store, {
          ...track.asset,
          resource: { ...track.asset.resource, digest: '0'.repeat(64) },
        }),
      ).rejects.toThrow();
      expect(store.state.config).toEqual(defaultMusicConfig());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
