import { join } from 'node:path';
import { canonicalJson } from '@mizar/hud-config';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  MulnxToolRef,
  ResourceRef,
} from '@mizar/broadcast-config';
import type { MusicStore } from '../music/store.js';
import { readMusicAsset } from './music-assets.js';
import { BroadcastReferenceQueue } from './reference-queue.js';
import type { BroadcastRuntimeDependencies } from './runtime.js';
import type { CameraConfigResolver } from './camera.js';
import type { MusicPackResources } from './music-pack-resources.js';
import { assertSupportedProgram } from './resolver.js';

/** Built-in providers support native HUD, Pulse, local music and verified camera resources. */
export function createProductionBroadcastDependencies(
  directory: string,
  music: MusicStore,
  readAdditionalAsset: (ref: AssetRef) => Promise<void>,
  musicPacks?: MusicPackResources,
  camera?: CameraConfigResolver,
): BroadcastRuntimeDependencies {
  const references = new BroadcastReferenceQueue();
  const asset = async (ref: AssetRef) => {
    if (ref.resource.id.startsWith('local:music:')) await readMusicAsset(music, ref);
    else if (ref.resource.id.startsWith('local:mizar-pack:') && musicPacks)
      await musicPacks.readAsset(ref);
    else await readAdditionalAsset(ref);
  };
  const localTrackId = async (ref: AssetRef) => {
    if (ref.resource.id.startsWith('local:mizar-pack:') && musicPacks)
      return musicPacks.materialize(ref, music);
    await readMusicAsset(music, ref);
    return ref.fileId;
  };
  const image = async (ref: AssetRef) => {
    if (!ref.resource.id.startsWith('local:mizar-pack:') || !musicPacks)
      throw new Error('dependency_missing');
    const owner = musicPacks as MusicPackResources & {
      readAsset?: (asset: AssetRef) => Promise<{ mediaType: string }>;
    };
    if (!owner.readAsset) throw new Error('capability_unsupported');
    const file = await owner.readAsset(ref);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mediaType))
      throw new Error('capability_unsupported');
  };
  const lockForActive = async (resolved: ActiveBroadcastSnapshot['resolved']) => {
    if (resolved.hud.renderer !== 'native') throw new Error('capability_unsupported');
    const resources = new Map<string, ResourceRef>();
    const add = async (ref: AssetRef) => {
      await asset(ref);
      resources.set(canonicalJson(ref.resource), ref.resource);
    };
    assertSupportedProgram(resolved.program);
    for (const scene of Object.values(resolved.program.scenes))
      if (scene.kind !== 'builtin' || scene.id !== 'pulse')
        throw new Error('capability_unsupported');
    for (const ref of Object.values(resolved.program.assets)) {
      await image(ref);
      resources.set(canonicalJson(ref.resource), ref.resource);
    }
    if (resolved.music)
      for (const group of MUSIC_GROUPS)
        for (const track of resolved.music.groups[group].tracks) {
          await localTrackId(track.asset);
          await add(track.asset);
        }
    const tools = new Map<string, MulnxToolRef>();
    if (resolved.camera)
      for (const map of resolved.camera.maps) {
        if (!camera) throw new Error('camera_identity_unavailable');
        const tool = await camera.camera(map.source);
        tools.set(canonicalJson(tool), tool);
        if (map.openingSound) await add(map.openingSound.asset);
      }
    return { resources: [...resources.values()], tools: [...tools.values()] };
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
      image,
      hud: () => Promise.reject(new Error('capability_unsupported')),
      scene: (value) =>
        value.kind === 'builtin' && value.id === 'pulse'
          ? Promise.resolve()
          : Promise.reject(new Error('capability_unsupported')),
      camera: (source) =>
        camera?.camera(source) ?? Promise.reject(new Error('camera_identity_unavailable')),
    },
    camera: {
      localPack: (source) =>
        camera?.localPack(source) ?? Promise.reject(new Error('camera_identity_unavailable')),
      localTrackId,
      portable: (preset, automaticEnabled) =>
        camera
          ? camera.cameraConfig(preset, automaticEnabled)
          : preset.maps.length
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
      const sort = (values: (ResourceRef | MulnxToolRef)[]) => values.map(canonicalJson).sort();
      if (canonicalJson(sort(expected.resources)) !== canonicalJson(sort(active.lock.resources)))
        throw new Error('dependency_missing');
      // The selected release can change while providing the same verified camera content.
      // Keep the snapshot's historical lock, but require the currently verified provider.
      if (
        expected.tools.length !== active.lock.tools.length ||
        active.lock.tools.some(
          (tool) => tool.kind !== 'upstream' || tool.release.repository !== 'Co1Swet/MulNX_CS2',
        )
      )
        throw new Error('dependency_missing');
    },
  };
}
