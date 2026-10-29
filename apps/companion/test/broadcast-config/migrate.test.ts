import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { getBuiltinLayout } from '@mizar/hud-config';
import { defaultMusicConfig } from '@mizar/protocol/music';
import { emptyOrchestrationPreset } from '@mizar/protocol/orchestration';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { migrateLegacyBroadcast } from '../../src/broadcast-config/migrate.js';

it('preserves the active camera independently of its newer draft', async () => {
  const hud = new HudConfigStore().getState();
  const id = randomUUID();
  const camera = emptyOrchestrationPreset();
  const draft = { ...camera, name: '新草稿' };
  const document = await migrateLegacyBroadcast({
    hud,
    music: defaultMusicConfig(),
    camera: {
      activePresetId: id,
      presets: [{ id, preset: draft }],
      active: camera,
      automaticEnabled: false,
    },
    overlays: {
      pause: { enabled: true, visual: 'default' },
      chat: { enabled: true, placement: Object.values(getBuiltinLayout().widgets)[0]! },
    },
    musicConfig: async (config) => ({
      ...config,
      automaticEnabled: true,
      groups: Object.fromEntries(
        Object.entries(config.groups).map(([name, group]) => [name, { ...group, tracks: [] }]),
      ) as never,
    }),
    cameraConfig: async (preset, automaticEnabled) => ({
      format: 'mizar.camera-config',
      version: 2,
      name: preset.name,
      automaticEnabled,
      maps: [],
    }),
    lock: async () => ({ resources: [], tools: [] }),
  });
  const draftModule = document.modules.find((module) => module.id === id);
  expect(draftModule?.name).toBe('新草稿');
  expect(document.active.resolved.camera?.name).toBe(camera.name);
  expect(document.active.resolved.camera?.automaticEnabled).toBe(false);
  expect(document.active.adjusted).toBe(true);
});
