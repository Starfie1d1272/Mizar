import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@mizar/hud-config';
import {
  defaultMusicConfig,
  musicConfigSchema,
  MUSIC_GROUPS,
  type MusicConfig,
} from '@mizar/protocol/music';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  PortableMusicConfigV1,
} from '@mizar/broadcast-config';
import type { MusicConfigPersistence, MusicStore } from '../music/store.js';
import type { BroadcastConfigStore } from './store.js';
import { portableMusicConfig, readMusicAsset } from './music-assets.js';
import { isBuiltinModuleId } from './builtin-modules.js';

function musicRevision(revision: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revision))
    return revision;
  const digest = createHash('sha256').update(revision).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** The asset owner may materialize a verified package asset to a local music track ID. */
export function createMusicConfigPersistence(
  store: BroadcastConfigStore,
  music: MusicStore,
  lockFor: (
    value: PortableMusicConfigV1,
    current: ActiveBroadcastSnapshot,
  ) => Promise<ActiveBroadcastSnapshot['lock']>,
  localTrackId: (ref: AssetRef) => Promise<string> = async (ref) => {
    await readMusicAsset(music, ref);
    return ref.fileId;
  },
): MusicConfigPersistence {
  async function toLocal(value: PortableMusicConfigV1 | null): Promise<MusicConfig> {
    const config = defaultMusicConfig();
    if (!value) {
      for (const group of MUSIC_GROUPS) config.groups[group].enabled = false;
      return config;
    }
    for (const group of MUSIC_GROUPS) {
      const { tracks, ...settings } = value.groups[group];
      config.groups[group] = {
        ...settings,
        tracks: await Promise.all(
          tracks.map(async ({ asset, ...track }) => ({ ...track, id: await localTrackId(asset) })),
        ),
      };
    }
    return musicConfigSchema.parse(config);
  }
  async function read() {
    const active = store.snapshot.active;
    return {
      config: await toLocal(active.resolved.music),
      revision: musicRevision(active.moduleRevisions.music),
      automaticEnabled: active.resolved.music?.automaticEnabled ?? false,
    };
  }
  return {
    initialize: () => read(),
    read,
    async commit(config, previous) {
      const document = store.snapshot;
      const active = document.active;
      if (canonicalJson(await toLocal(active.resolved.music)) !== canonicalJson(previous))
        throw new Error('revision_conflict');
      const value = await portableMusicConfig(
        music,
        config,
        active.resolved.music?.automaticEnabled ?? false,
      );
      const lock = await lockFor(value, active);
      const captured = document.modules.find(
        (item) => item.id === active.sourceModuleIds?.music && item.kind === 'music',
      );
      const usages = captured
        ? document.presets.filter((preset) =>
            preset.bindings.some(
              (binding) => binding.mode === 'use' && binding.moduleId === captured.id,
            ),
          ).length
        : 0;
      const reusable =
        captured?.kind === 'music' &&
        !isBuiltinModuleId(captured.id) &&
        usages <= 1 &&
        canonicalJson(captured.value) === canonicalJson(active.resolved.music);
      const moduleId = reusable ? captured.id : randomUUID();
      await store.updateFromLegacy({
        updateDraft(next) {
          if (next.active.revision !== active.revision) throw new Error('revision_conflict');
          const existing = next.modules.find((item) => item.id === moduleId);
          if (reusable) {
            if (!existing || existing.kind !== 'music' || existing.revision !== captured.revision)
              throw new Error('revision_conflict');
            existing.value = value;
          } else {
            if (existing) throw new Error('revision_conflict');
            next.modules.push({
              id: moduleId,
              kind: 'music',
              schemaVersion: 1,
              revision: randomUUID(),
              name: '音乐',
              value,
              origin: null,
            });
          }
        },
        active: { kind: 'music', value, lock, moduleId },
      });
      return read();
    },
  };
}
