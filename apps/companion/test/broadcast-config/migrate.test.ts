import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { getBuiltinLayout, getBuiltinPreset, getBuiltinTheme } from '@mizar/hud-config';
import { defaultMusicConfig } from '@mizar/protocol/music';
import { emptyOrchestrationPreset } from '@mizar/protocol/orchestration';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { legacyOverlays, migrateLegacyBroadcast } from '../../src/broadcast-config/migrate.js';

it('preserves the active camera independently of its newer draft', async () => {
  const hud = new HudConfigStore().getState();
  hud.resolved.layout.widgets['top-score-bar'].visible = false;
  hud.resolved.layout.widgets['team-t-rail'].visible = false;
  const layout = { ...getBuiltinLayout(), id: 'custom:unbound-layout', name: 'Unbound layout' };
  const theme = { ...getBuiltinTheme(), id: 'custom:unbound-theme', name: 'Unbound theme' };
  hud.document.customLayouts.push(layout);
  hud.document.customThemes.push(theme);
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
    musicConfig: (config) =>
      Promise.resolve({
        ...config,
        automaticEnabled: true,
        groups: Object.fromEntries(
          Object.entries(config.groups).map(([name, group]) => [name, { ...group, tracks: [] }]),
        ) as never,
      }),
    cameraConfig: (preset, automaticEnabled) =>
      Promise.resolve({
        format: 'mizar.camera-config',
        version: 2,
        name: preset.name,
        automaticEnabled,
        maps: [],
      }),
    lock: () => Promise.resolve({ resources: [], tools: [] }),
  });
  const draftModule = document.modules.find((module) => module.id === id);
  expect(draftModule?.name).toBe('新草稿');
  expect(document.active.resolved.camera?.name).toBe(camera.name);
  expect(document.active.resolved.camera?.automaticEnabled).toBe(false);
  expect(document.active.adjusted).toBe(true);
  const activeHud = document.active.resolved.hud;
  if (activeHud.renderer !== 'native') throw new Error('unexpected HUD');
  expect(activeHud.overlays).toEqual({
    pause: { enabled: false, visual: 'legacy' },
    chat: { enabled: false, placement: 'auto' },
  });
  expect(activeHud.accent).toEqual({ source: 'fixed', value: hud.resolved.theme.brandColor });
  expect(document.unboundHudResources).toEqual({ layouts: [layout], themes: [theme] });
});

it('reports pending when camera content cannot yet be identified', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MusicStore } = await import('../../src/music/store.js');
  const { OrchestrationStore } = await import('../../src/orchestration/store.js');
  const { prepareLegacyMigration } =
    await import('../../src/broadcast-config/prepare-migration.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-migrate-'));
  try {
    const music = new MusicStore(join(root, 'music'));
    const camera = new OrchestrationStore(join(root, 'camera'));
    await music.load();
    await camera.load();
    const options = {
      hud: new HudConfigStore().getState(),
      music,
      camera,
      musicAutomaticEnabled: true,
      overlays: {
        pause: { enabled: true, visual: 'default' },
        chat: { enabled: true, placement: Object.values(getBuiltinLayout().widgets)[0]! },
      },
    };
    const ready = await prepareLegacyMigration(options);
    expect(ready.state).toBe('ready');
    camera.preset.maps.push({ map: 'de_test' } as never);
    expect(await prepareLegacyMigration(options)).toEqual({
      state: 'pending',
      reason: 'camera_identity_unavailable',
    });
    expect(camera.preset.maps).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('maps both legacy pause controls and retains automatic chat placement', () => {
  const layout = getBuiltinLayout();
  const preset = getBuiltinPreset();
  layout.widgets['top-score-bar'].visible = true;
  preset.widgets['top-score-bar'].settings.showTimeout = false;
  expect(legacyOverlays(layout, preset.widgets).pause.enabled).toBe(false);
  preset.widgets['top-score-bar'].settings.showTimeout = true;
  expect(legacyOverlays(layout, preset.widgets).pause.enabled).toBe(true);
  expect(legacyOverlays(layout, preset.widgets).chat.placement).toBe('auto');
});
