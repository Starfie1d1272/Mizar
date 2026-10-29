import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  MUSIC_GROUPS,
  musicConfigSchema,
  musicTrackSchema,
  type MusicConfig,
  type MusicTrack,
} from '@mizar/protocol/music';
import type { AssetRef, PortableMusicConfigV1, PortableTrack } from '@mizar/broadcast-config';
import { audioBytes } from '../music/archive.js';
import type { MusicStore } from '../music/store.js';

/** The music owner addresses tracks by a verified hash and audio extension. */
export function musicAssetRef(id: string): AssetRef {
  if (!/^[a-f0-9]{64}\.(wav|mp3|ogg|flac|m4a)$/.test(id)) throw new Error('music_track_invalid');
  return {
    resource: { id: `local:music:${id}`, version: '1', digest: id.slice(0, 64) },
    fileId: id,
  };
}

/** Resolve only our own namespace, then independently check the bytes read. */
export async function readMusicAsset(store: MusicStore, ref: AssetRef): Promise<Buffer> {
  const expected = musicAssetRef(ref.fileId);
  if (
    ref.resource.id !== expected.resource.id ||
    ref.resource.version !== expected.resource.version ||
    ref.resource.digest !== expected.resource.digest
  )
    throw new Error('music_track_invalid');
  const bytes = await readFile(await store.trackPath(ref.fileId));
  if (
    !audioBytes(ref.fileId, bytes) ||
    createHash('sha256').update(bytes).digest('hex') !== ref.resource.digest
  )
    throw new Error('music_track_invalid');
  return bytes;
}

/** Converts one legacy track, including standalone camera opening sounds. */
export async function portableMusicTrack(
  store: MusicStore,
  value: MusicTrack,
): Promise<PortableTrack> {
  const track = musicTrackSchema.parse(value);
  const asset = musicAssetRef(track.id);
  await readMusicAsset(store, asset);
  return {
    entryId: track.entryId ?? randomUUID(),
    asset,
    name: track.name,
    startMs: track.startMs,
    endMs: track.endMs,
    ...(track.gain === undefined ? {} : { gain: track.gain }),
  };
}

/** Builds a migration candidate without changing the music owner or playback. */
export async function portableMusicConfig(
  store: MusicStore,
  input: MusicConfig,
  automaticEnabled: boolean,
): Promise<PortableMusicConfigV1> {
  const config = musicConfigSchema.parse(input);
  const groups = {} as PortableMusicConfigV1['groups'];
  for (const group of MUSIC_GROUPS) {
    const { tracks, ...settings } = config.groups[group];
    groups[group] = {
      ...settings,
      tracks: await Promise.all(tracks.map((track) => portableMusicTrack(store, track))),
    };
  }
  return { version: 1, automaticEnabled, groups };
}
