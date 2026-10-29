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
import { portableMusicConfig } from './music-assets.js';

export type PreparedLegacyMigration =
  | { state: 'ready'; document: BroadcastConfigDocument }
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
  overlays: LegacyBroadcastMigration['overlays'];
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
  if (hasCameraSource && (!input.cameraConfig || !input.lock))
    return { state: 'pending', reason: 'camera_identity_unavailable' };
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
  try {
    const document = await migrateLegacyBroadcast({
      hud: input.hud,
      music: input.music.state.config,
      musicRevision: input.music.state.configRevision,
      camera: {
        presets: input.camera.presets,
        activePresetId: input.camera.activePresetId,
        active: input.camera.preset,
        automaticEnabled: input.camera.automaticEnabled,
      },
      overlays: input.overlays,
      musicConfig: (value) => portableMusicConfig(input.music, value, input.musicAutomaticEnabled),
      cameraConfig: input.cameraConfig ?? emptyCamera,
      lock: input.lock ?? localLock,
    });
    return { state: 'ready', document };
  } catch {
    return { state: 'pending', reason: 'dependency_unavailable' };
  }
}
