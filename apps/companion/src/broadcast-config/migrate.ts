import { randomUUID } from 'node:crypto';
import { canonicalJson, getBuiltinLayouts, getBuiltinThemes } from '@mizar/hud-config';
import {
  parseBroadcastConfigDocument,
  type ActiveBroadcastSnapshot,
  type BroadcastConfigDocument,
  type CameraModuleV2,
  type HudModule,
  type ModuleRecord,
  type PortableMusicConfigV1,
} from '@mizar/broadcast-config';
import type { MusicConfig } from '@mizar/protocol/music';
import type { OrchestrationPreset } from '@mizar/protocol/orchestration';
import type { HudConfigState } from '../hud-config/store.js';
import { createBuiltinModules, legacyOverlays } from './builtin-modules.js';
export { legacyOverlays } from './builtin-modules.js';

/** Conversion must verify existing media and camera source identities before returning. */
export interface LegacyBroadcastMigration {
  hud: HudConfigState;
  music: MusicConfig;
  musicRevision?: string;
  camera: {
    presets: { id: string; preset: OrchestrationPreset }[];
    activePresetId: string;
    active: OrchestrationPreset;
    automaticEnabled: boolean;
  };
  musicConfig(value: MusicConfig): Promise<PortableMusicConfigV1>;
  cameraConfig(value: OrchestrationPreset, automaticEnabled: boolean): Promise<CameraModuleV2>;
  lock(resolved: ActiveBroadcastSnapshot['resolved']): Promise<ActiveBroadcastSnapshot['lock']>;
  skipCamera?: boolean;
}

/** Builds a complete candidate only; callers publish it after verifying dependencies and backing up legacy files. */
export async function migrateLegacyBroadcast(
  input: LegacyBroadcastMigration,
): Promise<BroadcastConfigDocument> {
  const { document } = input.hud;
  const layouts = [...getBuiltinLayouts(), ...document.customLayouts];
  const themes = [...getBuiltinThemes(), ...document.customThemes];
  const builtins = createBuiltinModules();
  const hudModules: ModuleRecord<'hud'>[] = [
    ...builtins.filter((item): item is ModuleRecord<'hud'> => item.kind === 'hud'),
    ...document.customPresets.map<ModuleRecord<'hud'>>((preset) => {
      const layout = layouts.find((item) => item.id === preset.layoutId);
      const theme = themes.find((item) => item.id === preset.themeId);
      if (!layout || !theme) throw new Error('hud_resource_missing');
      const value: HudModule = {
        renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
        preset: structuredClone(preset),
        layout: structuredClone(layout),
        theme: structuredClone(theme),
        overlays: legacyOverlays(layout, preset.widgets),
        accent: { source: 'fixed', value: theme.brandColor },
      };
      return {
        id: randomUUID(),
        revision: randomUUID(),
        kind: 'hud',
        schemaVersion: 1,
        name: preset.name,
        value,
        origin: null,
      };
    }),
  ];
  const hud = hudModules.find(
    (item) => 'preset' in item.value && item.value.preset.id === document.activePreset.sourceId,
  );
  if (!hud) throw new Error('hud_resource_missing');
  const programModule = builtins.find(
    (item): item is ModuleRecord<'program'> => item.kind === 'program',
  )!;
  const program = programModule.value;
  const musicModule: ModuleRecord<'music'> = {
    id: randomUUID(),
    revision: randomUUID(),
    kind: 'music',
    schemaVersion: 1,
    name: '当前音乐',
    value: await input.musicConfig(input.music),
    origin: null,
  };
  const cameraModules: ModuleRecord<'camera'>[] = [];
  for (const item of input.skipCamera ? [] : input.camera.presets)
    cameraModules.push({
      id: item.id,
      revision: randomUUID(),
      kind: 'camera',
      schemaVersion: 2,
      name: item.preset.name,
      value: await input.cameraConfig(item.preset, input.camera.automaticEnabled),
      origin: null,
    });
  const camera = cameraModules.find((item) => item.id === input.camera.activePresetId);
  if (!camera && !input.skipCamera) throw new Error('camera_preset_missing');
  const preset = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    revision: randomUUID(),
    name: '当前方案',
    origin: null,
    opaqueModules: [],
    bindings: [
      { kind: 'hud' as const, mode: 'use' as const, moduleId: hud.id },
      { kind: 'program' as const, mode: 'use' as const, moduleId: programModule.id },
      { kind: 'music' as const, mode: 'use' as const, moduleId: musicModule.id },
      ...(camera
        ? [{ kind: 'camera' as const, mode: 'use' as const, moduleId: camera.id }]
        : [{ kind: 'camera' as const, mode: 'off' as const }]),
    ],
  };
  const resolved: ActiveBroadcastSnapshot['resolved'] = {
    hud: {
      renderer: 'native',
      config: structuredClone(input.hud.resolved),
      overlays: legacyOverlays(input.hud.resolved.layout, input.hud.resolved.widgets),
      accent: { source: 'fixed', value: input.hud.resolved.theme.brandColor },
    },
    program,
    music: structuredClone(musicModule.value),
    camera: camera
      ? await input.cameraConfig(input.camera.active, input.camera.automaticEnabled)
      : null,
  };
  const active: ActiveBroadcastSnapshot = {
    schemaVersion: 1,
    revision: randomUUID(),
    sourcePreset: { id: preset.id, revision: preset.revision },
    adjusted:
      input.hud.activationStale ||
      canonicalJson(input.camera.active) !==
        canonicalJson(
          input.camera.presets.find((item) => item.id === input.camera.activePresetId)!.preset,
        ),
    sourceModuleIds: {
      hud: hud.id,
      program: programModule.id,
      music: musicModule.id,
      camera: camera?.id ?? null,
    },
    sourceModuleRevisions: {
      hud: hud.revision,
      program: programModule.revision,
      music: musicModule.revision,
      camera: camera?.revision ?? null,
    },
    moduleRevisions: {
      hud: randomUUID(),
      program: randomUUID(),
      music: input.musicRevision ?? randomUUID(),
      camera: randomUUID(),
    },
    resolved,
    lock: await input.lock(resolved),
  };
  return parseBroadcastConfigDocument({
    schemaVersion: 1,
    modules: [...hudModules, programModule, musicModule, ...cameraModules],
    presets: [preset],
    unboundHudResources: {
      layouts: document.customLayouts.filter(
        (layout) => !document.customPresets.some((item) => item.layoutId === layout.id),
      ),
      themes: document.customThemes.filter(
        (theme) => !document.customPresets.some((item) => item.themeId === theme.id),
      ),
    },
    active,
    previousActive: null,
  });
}
