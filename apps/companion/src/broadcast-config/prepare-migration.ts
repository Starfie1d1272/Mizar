import { canonicalJson } from '@mizar/hud-config';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type {
  ActiveBroadcastSnapshot,
  BroadcastConfigDocument,
  CameraModuleV2,
  ResourceRef,
} from '@mizar/broadcast-config';
import type { HudConfigState } from '../hud-config/store.js';
import type { MusicStore } from '../music/store.js';
import type { OrchestrationStore } from '../orchestration/store.js';
import { migrateLegacyBroadcast, type LegacyBroadcastMigration } from './migrate.js';
import { portableMusicDraft } from './music-assets.js';
import type { PendingLegacyCamera } from './store.js';

export type PreparedLegacyMigration =
  | { state: 'ready'; document: BroadcastConfigDocument; pendingLegacyCamera?: PendingLegacyCamera }
  | {
      state: 'pending';
      reason: 'owner_unavailable' | 'camera_identity_unavailable' | 'dependency_unavailable';
    };

/** No writes or runtime actions: a caller may retain the old owners until activation is supported. */
export async function prepareLegacyMigration(input: {
  hud: HudConfigState;
  music: MusicStore;
  camera: OrchestrationStore;
  musicAutomaticEnabled: boolean;
  cameraConfig?: LegacyBroadcastMigration['cameraConfig'];
  lock?: LegacyBroadcastMigration['lock'];
}): Promise<PreparedLegacyMigration> {
  if (
    !input.music.ready ||
    !input.camera.ready ||
    input.music.failure ||
    input.hud.persistenceError
  )
    return { state: 'pending', reason: 'owner_unavailable' };
  const hasCameraSource =
    input.camera.preset.maps.length > 0 ||
    input.camera.presets.some((item) => item.preset.maps.length > 0);
  const emptyCamera: LegacyBroadcastMigration['cameraConfig'] = (preset, automaticEnabled) =>
    Promise.resolve({
      format: 'mizar.camera-config',
      version: 2,
      name: preset.name,
      automaticEnabled,
      maps: [],
    } satisfies CameraModuleV2);
  const localLock = (
    resolved: ActiveBroadcastSnapshot['resolved'],
  ): Promise<ActiveBroadcastSnapshot['lock']> => {
    const refs = new Map<string, ResourceRef>();
    if (resolved.music)
      for (const group of MUSIC_GROUPS)
        for (const track of resolved.music.groups[group].tracks)
          refs.set(canonicalJson(track.asset.resource), track.asset.resource);
    return Promise.resolve({ resources: [...refs.values()], tools: [] });
  };
  const migrate = (skipCamera: boolean) =>
    migrateLegacyBroadcast({
      hud: input.hud,
      music: input.music.state.config,
      musicRevision: input.music.state.configRevision,
      camera: {
        presets: input.camera.presets,
        activePresetId: input.camera.activePresetId,
        active: input.camera.preset,
        automaticEnabled: input.camera.automaticEnabled,
      },
      musicConfig: (value) =>
        Promise.resolve(portableMusicDraft(value, input.musicAutomaticEnabled)),
      cameraConfig: input.cameraConfig ?? emptyCamera,
      lock: async (resolved) => {
        // Unavailable legacy audio remains a desired configuration, not a successful application.
        // Verify the independent modules now; the music consumer verifies every track on bind/retry.
        const lock = input.lock
          ? await input.lock({ ...resolved, music: null })
          : await localLock(resolved);
        const music = await localLock(resolved);
        const resources = new Map(
          [...lock.resources, ...music.resources].map((ref) => [canonicalJson(ref), ref]),
        );
        return { ...lock, resources: [...resources.values()] };
      },
      skipCamera,
    });
  try {
    if (hasCameraSource && (!input.cameraConfig || !input.lock))
      throw new Error('camera_identity_unavailable');
    return { state: 'ready', document: await migrate(false) };
  } catch (error) {
    if (hasCameraSource) {
      try {
        const document = await migrate(true);
        return {
          state: 'ready',
          document,
          pendingLegacyCamera: {
            catalog: {
              presets: structuredClone(input.camera.presets),
              activePresetId: input.camera.activePresetId,
              preset: structuredClone(input.camera.preset),
            },
            automaticEnabled: input.camera.automaticEnabled,
            reason: 'camera_identity_unavailable',
          },
        };
      } catch {
        // A non-camera dependency is unavailable too; retain the legacy owners.
      }
    }
    return {
      state: 'pending',
      reason:
        error instanceof Error && error.message === 'camera_identity_unavailable'
          ? 'camera_identity_unavailable'
          : 'dependency_unavailable',
    };
  }
}
