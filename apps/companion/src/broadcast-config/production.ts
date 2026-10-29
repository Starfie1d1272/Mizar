import { join } from 'node:path';
import { canonicalJson } from '@mizar/hud-config';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type { ActiveBroadcastSnapshot, AssetRef, ResourceRef } from '@mizar/broadcast-config';
import type { MusicStore } from '../music/store.js';
import { readMusicAsset } from './music-assets.js';
import { BroadcastReferenceQueue } from './reference-queue.js';
import type { BroadcastRuntimeDependencies } from './runtime.js';
import type { MusicPackResources } from './music-pack-resources.js';

/** Built-in providers support native HUD, Pulse, local music and an empty camera configuration. */
export function createProductionBroadcastDependencies(
  directory: string,
  music: MusicStore,
  readAdditionalAsset: (ref: AssetRef) => Promise<void>,
  musicPacks?: MusicPackResources,
): BroadcastRuntimeDependencies {
  const references = new BroadcastReferenceQueue();
  const asset = async (ref: AssetRef) => {
    if (ref.resource.id.startsWith('local:music:')) await readMusicAsset(music, ref);
    else if (ref.resource.id.startsWith('local:mizar-pack:') && musicPacks)
      await musicPacks.read(ref);
    else await readAdditionalAsset(ref);
  };
  const localTrackId = async (ref: AssetRef) => {
    if (ref.resource.id.startsWith('local:mizar-pack:') && musicPacks)
      return musicPacks.materialize(ref, music);
    await readMusicAsset(music, ref);
    return ref.fileId;
  };
  const lockForActive = async (resolved: ActiveBroadcastSnapshot['resolved']) => {
    if (resolved.hud.renderer !== 'native') throw new Error('capability_unsupported');
    const resources = new Map<string, ResourceRef>();
    const add = async (ref: AssetRef) => {
      await asset(ref);
      resources.set(canonicalJson(ref.resource), ref.resource);
    };
    for (const scene of Object.values(resolved.program.scenes))
      if (scene.kind !== 'builtin' || scene.id !== 'pulse')
        throw new Error('capability_unsupported');
    for (const ref of Object.values(resolved.program.assets)) await add(ref);
    if (resolved.music)
      for (const group of MUSIC_GROUPS)
        for (const track of resolved.music.groups[group].tracks) {
          await localTrackId(track.asset);
          await add(track.asset);
        }
    if (resolved.camera?.maps.length) throw new Error('camera_identity_unavailable');
    return { resources: [...resources.values()], tools: [] };
  };
  return {
    path: join(directory, 'broadcast-config.json'),
    musicAutomaticEnabled: true,
    references,
    isDeleting: (ref) =>
      ref.id.startsWith('local:music:') || (ref.id.startsWith('local:mizar-pack:') && musicPacks)
        ? Promise.resolve(false)
        : Promise.reject(new Error('provider_unavailable')),
    resolve: {
      asset,
      hud: () => Promise.reject(new Error('capability_unsupported')),
      scene: (value) =>
        value.kind === 'builtin' && value.id === 'pulse'
          ? Promise.resolve()
          : Promise.reject(new Error('capability_unsupported')),
      camera: () => Promise.reject(new Error('camera_identity_unavailable')),
    },
    camera: {
      localPack: () => Promise.reject(new Error('camera_identity_unavailable')),
      localTrackId,
      portable: (preset, automaticEnabled) =>
        preset.maps.length
          ? Promise.reject(new Error('camera_identity_unavailable'))
          : Promise.resolve({
              format: 'mizar.camera-config',
              version: 2,
              name: preset.name,
              maps: [],
              automaticEnabled,
            }),
      lock: (value, active) => lockForActive({ ...active.resolved, camera: value }),
    },
    localTrackId,
    lockForActive,
    verifyActive: async (active) => {
      const expected = await lockForActive(active.resolved);
      const sort = (values: ResourceRef[]) => values.map(canonicalJson).sort();
      if (
        canonicalJson(sort(expected.resources)) !== canonicalJson(sort(active.lock.resources)) ||
        active.lock.tools.length
      )
        throw new Error('dependency_missing');
    },
  };
}
