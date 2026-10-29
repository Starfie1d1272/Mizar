import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  getBuiltinLayouts,
  getBuiltinPresets,
  getBuiltinThemes,
  type HudWidgetPlacement,
} from '@mizar/hud-config';
import {
  parseBroadcastConfigDocument,
  type ActiveBroadcastSnapshot,
  type BroadcastConfigDocument,
  type CameraModuleV2,
  type HudModule,
  type ModuleRecord,
  type PortableMusicConfigV1,
  type ProgramVisualConfigV1,
} from '@mizar/broadcast-config';
import type { MusicConfig } from '@mizar/protocol/music';
import type { OrchestrationPreset } from '@mizar/protocol/orchestration';
import type { HudConfigState } from '../hud-config/store.js';

/** Conversion must verify existing media and camera source identities before returning. */
export interface LegacyBroadcastMigration {
  hud: HudConfigState;
  music: MusicConfig;
  camera: {
    presets: { id: string; preset: OrchestrationPreset }[];
    activePresetId: string;
    active: OrchestrationPreset;
    automaticEnabled: boolean;
  };
  overlays: {
    pause: { enabled: boolean; visual: string };
    chat: { enabled: boolean; placement: HudWidgetPlacement };
  };
  musicConfig(value: MusicConfig): Promise<PortableMusicConfigV1>;
  cameraConfig(value: OrchestrationPreset, automaticEnabled: boolean): Promise<CameraModuleV2>;
  lock(resolved: ActiveBroadcastSnapshot['resolved']): Promise<ActiveBroadcastSnapshot['lock']>;
}

/** Builds a complete candidate only; callers publish it after verifying dependencies and backing up legacy files. */
export async function migrateLegacyBroadcast(
  input: LegacyBroadcastMigration,
): Promise<BroadcastConfigDocument> {
  const { document } = input.hud;
  const layouts = [...getBuiltinLayouts(), ...document.customLayouts];
  const themes = [...getBuiltinThemes(), ...document.customThemes];
  const hudModules: ModuleRecord<'hud'>[] = [...getBuiltinPresets(), ...document.customPresets].map(
    (preset) => {
      const layout = layouts.find((item) => item.id === preset.layoutId);
      const theme = themes.find((item) => item.id === preset.themeId);
      if (!layout || !theme) throw new Error('hud_resource_missing');
      const value: HudModule = {
        renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
        preset: structuredClone(preset),
        layout: structuredClone(layout),
        theme: structuredClone(theme),
        overlays: structuredClone(input.overlays),
        accent: { source: 'event', fallback: theme.brandColor },
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
    },
  );
  const hud = hudModules.find(
    (item) => 'preset' in item.value && item.value.preset.id === document.activePreset.sourceId,
  );
  if (!hud) throw new Error('hud_resource_missing');
  const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 } as const;
  const program: ProgramVisualConfigV1 = {
    scenes: {
      waiting: visual,
      matchup: visual,
      bp: visual,
      halftime: visual,
      map_result: visual,
      intermap: visual,
      match_result: visual,
    },
    tokens: {},
    assets: {},
  };
  const programModule: ModuleRecord<'program'> = {
    id: randomUUID(),
    revision: randomUUID(),
    kind: 'program',
    schemaVersion: 1,
    name: 'Pulse',
    value: program,
    origin: null,
  };
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
  for (const item of input.camera.presets)
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
  if (!camera) throw new Error('camera_preset_missing');
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
      { kind: 'camera' as const, mode: 'use' as const, moduleId: camera.id },
    ],
  };
  const resolved: ActiveBroadcastSnapshot['resolved'] = {
    hud: {
      renderer: 'native',
      config: structuredClone(input.hud.resolved),
      overlays: structuredClone(input.overlays),
      accent: { source: 'event', fallback: input.hud.resolved.theme.brandColor },
    },
    program,
    music: structuredClone(musicModule.value),
    camera: await input.cameraConfig(input.camera.active, input.camera.automaticEnabled),
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
    moduleRevisions: {
      hud: randomUUID(),
      program: randomUUID(),
      music: randomUUID(),
      camera: randomUUID(),
    },
    resolved,
    lock: await input.lock(resolved),
  };
  return parseBroadcastConfigDocument({
    schemaVersion: 1,
    modules: [...hudModules, programModule, musicModule, ...cameraModules],
    presets: [preset],
    active,
    previousActive: null,
  });
}
