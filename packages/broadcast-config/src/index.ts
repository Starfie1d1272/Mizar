import { canonicalJson } from '@mizar/hud-config';
import type {
  HudLayout,
  HudPreset,
  HudResolvedPreset,
  HudTheme,
  HudWidgetPlacement,
} from '@mizar/hud-config';
import type { MusicConfig, MusicGroup } from '@mizar/protocol/music';
import type { CameraMap } from '@mizar/protocol/orchestration';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';

/** Opaque concurrency token; equality is the only supported operation. */
export type Revision = string;
export interface ResourceRef {
  id: string;
  version: string;
  digest: string;
}
export interface AssetRef {
  resource: ResourceRef;
  fileId: string;
}
export type ModuleKind = 'hud' | 'program' | 'music' | 'camera';
export const MODULE_KINDS: readonly ModuleKind[] = ['hud', 'program', 'music', 'camera'];
export type VisualColor =
  { source: 'fixed'; value: string } | { source: 'event'; fallback: string };
export type PanelValue =
  string | number | boolean | null | { entity: 'player' | 'match'; binding: string };
export type HudModule =
  | {
      renderer: { kind: 'native'; id: 'mizar.hud'; apiVersion: 1 };
      preset: HudPreset;
      layout: HudLayout;
      theme: HudTheme;
      overlays: {
        pause: { enabled: boolean; visual: string };
        chat: { enabled: boolean; placement: HudWidgetPlacement };
      };
      accent: VisualColor;
    }
  | {
      renderer: {
        kind: 'web-hud';
        resource: ResourceRef;
        profile: 'lhm-cs2-v1';
        variant: string | null;
      };
      panelValues: Record<string, PanelValue>;
      panelAssets: Record<string, AssetRef>;
    };
export type SceneVisualRef =
  | { kind: 'builtin'; id: string; apiVersion: 1 }
  | { kind: 'declarative'; resource: ResourceRef; fileId: string; apiVersion: 1 };
export interface ProgramVisualConfigV1 {
  scenes: Record<Exclude<ProgramSceneId, 'gameplay'>, SceneVisualRef>;
  tokens: Record<string, string | number>;
  assets: Record<string, AssetRef>;
}
export interface PortableTrack {
  entryId: string;
  asset: AssetRef;
  name: string;
  startMs: number;
  endMs: number | null;
  gain?: number;
}
export interface PortableMusicConfigV1 {
  version: 1;
  automaticEnabled: boolean;
  groups: {
    [G in MusicGroup]: Omit<MusicConfig['groups'][G], 'tracks'> & { tracks: PortableTrack[] };
  };
}
export interface MulnxReleaseRef {
  repository: 'Co1Swet/MulNX_CS2';
  releaseId: number;
  assetId: number;
  tag: string;
  archiveSha256: string;
}
export type MulnxToolRef =
  | { kind: 'upstream'; release: MulnxReleaseRef }
  | { kind: 'developer-fork'; repository: string; revision: string; archiveSha256: string };
/** Content identity is independent of the release from which it was obtained. */
export interface CameraSourceRef {
  sourceName: string;
  treeSha256: string;
  converterVersion: 1;
  acquisition: MulnxToolRef;
}
export type CameraMapConfig = Omit<CameraMap, 'pack' | 'openingSound'> & {
  source: CameraSourceRef;
  openingSound: PortableTrack | null;
};
export interface CameraModuleV2 {
  format: 'mizar.camera-config';
  version: 2;
  name: string;
  automaticEnabled: boolean;
  maps: CameraMapConfig[];
}
export interface ModulePayloadMap {
  hud: HudModule;
  program: ProgramVisualConfigV1;
  music: PortableMusicConfigV1;
  camera: CameraModuleV2;
}
export type ModuleOrigin = { resource: ResourceRef; entryId: string } | null;
export type ModuleRecord<K extends ModuleKind = ModuleKind> = {
  [P in K]: {
    id: string;
    kind: P;
    schemaVersion: number;
    revision: Revision;
    name: string;
    value: ModulePayloadMap[P];
    origin: ModuleOrigin;
  };
}[K];
export type ModuleBinding<K extends ModuleKind = ModuleKind> =
  { kind: K; mode: 'use'; moduleId: string } | { kind: K; mode: 'off' };
export interface OpaqueModuleRef {
  module: string;
  schemaVersion: number;
  source: ResourceRef;
  entryId: string;
  presetEntryId: string;
  required: false;
}
export interface BroadcastPreset {
  schemaVersion: 1;
  id: string;
  revision: Revision;
  name: string;
  bindings: ModuleBinding[];
  origin: ModuleOrigin;
  opaqueModules: OpaqueModuleRef[];
}
export type ResolvedHudModule =
  | {
      renderer: 'native';
      config: HudResolvedPreset;
      overlays: {
        pause: { enabled: boolean; visual: string };
        chat: { enabled: boolean; placement: HudWidgetPlacement };
      };
      accent: VisualColor;
    }
  | { renderer: 'web-hud'; config: Extract<HudModule, { renderer: { kind: 'web-hud' } }> };
export interface ActiveBroadcastSnapshot {
  schemaVersion: 1;
  revision: Revision;
  sourcePreset: { id: string; revision: Revision } | null;
  adjusted: boolean;
  moduleRevisions: Record<ModuleKind, Revision>;
  resolved: {
    hud: ResolvedHudModule;
    program: ProgramVisualConfigV1;
    music: PortableMusicConfigV1 | null;
    camera: CameraModuleV2 | null;
  };
  lock: { resources: ResourceRef[]; tools: MulnxToolRef[] };
}
export interface BroadcastConfigDocument {
  schemaVersion: 1;
  modules: ModuleRecord[];
  presets: BroadcastPreset[];
  active: ActiveBroadcastSnapshot;
  previousActive: ActiveBroadcastSnapshot | null;
}
/** A normal use request is prepared and committed internally in one operation. */
export interface ApplyPresetRequest {
  presetId: string;
  expectedRevision: Revision;
  expectedModuleRevisions: Partial<Record<ModuleKind, Revision>>;
  expectedActiveRevision: Revision;
  requestId: string;
}
export interface ClonePresetRequest {
  sourceId: string;
  expectedRevision: Revision;
  expectedModuleRevisions: Partial<Record<ModuleKind, Revision>>;
  name: string;
}

/** Validate the complete binding graph before cloning or using a preset. */
export function boundModules(
  preset: BroadcastPreset,
  modules: readonly ModuleRecord[],
): Map<ModuleKind, ModuleRecord | null> {
  const result = new Map<ModuleKind, ModuleRecord | null>();
  for (const binding of preset.bindings) {
    if (result.has(binding.kind)) throw new Error('duplicate_module_kind');
    if (binding.mode === 'off') {
      if (binding.kind === 'hud' || binding.kind === 'program')
        throw new Error('required_module_off');
      result.set(binding.kind, null);
    } else {
      const matches = modules.filter((module) => module.id === binding.moduleId);
      if (matches.length !== 1 || matches[0]!.kind !== binding.kind)
        throw new Error('module_missing');
      result.set(binding.kind, matches[0]!);
    }
  }
  if (MODULE_KINDS.some((kind) => !result.has(kind))) throw new Error('incomplete_preset');
  return result;
}

function checkRevisions(
  preset: BroadcastPreset,
  modules: Map<ModuleKind, ModuleRecord | null>,
  revision: Revision,
  expected: Partial<Record<ModuleKind, Revision>>,
) {
  if (preset.revision !== revision) throw new Error('revision_conflict');
  for (const [kind, module] of modules) {
    if (module && expected[kind] !== module.revision) throw new Error('revision_conflict');
  }
}

/** Copies editable modules and rewrites internal HUD resource IDs; immutable assets stay referenced. */
export function clonePreset(
  document: BroadcastConfigDocument,
  request: ClonePresetRequest,
  newId: () => string,
): { preset: BroadcastPreset; modules: ModuleRecord[] } {
  const source = document.presets.find((preset) => preset.id === request.sourceId);
  if (!source) throw new Error('preset_missing');
  const bound = boundModules(source, document.modules);
  checkRevisions(source, bound, request.expectedRevision, request.expectedModuleRevisions);
  const copies: ModuleRecord[] = [];
  const bindings: ModuleBinding[] = source.bindings.map((binding) => {
    if (binding.mode === 'off') return { ...binding };
    const module = structuredClone(bound.get(binding.kind)!);
    if (!module) throw new Error('module_missing');
    module.id = newId();
    module.revision = newId();
    if (module.kind === 'hud' && 'preset' in module.value) {
      const { preset, layout, theme } = module.value;
      layout.id = newId();
      theme.id = newId();
      preset.id = newId();
      preset.layoutId = layout.id;
      preset.themeId = theme.id;
    }
    copies.push(module);
    return { kind: binding.kind, mode: 'use', moduleId: module.id };
  });
  return {
    preset: {
      ...structuredClone(source),
      id: newId(),
      revision: newId(),
      name: request.name,
      bindings,
    },
    modules: copies,
  };
}

/** A resolver runs before committing and must not issue playback or device commands. */
export interface PresetResolver {
  resolve(
    modules: ReadonlyMap<ModuleKind, ModuleRecord | null>,
  ): Promise<Pick<ActiveBroadcastSnapshot, 'resolved' | 'lock'>>;
}

function effectiveModuleJson(
  kind: ModuleKind,
  value: ActiveBroadcastSnapshot['resolved'][ModuleKind],
): string {
  if (kind !== 'camera' || value === null) return canonicalJson(value);
  const camera = value as CameraModuleV2;
  return canonicalJson({
    ...camera,
    maps: camera.maps.map(({ source, ...map }) => ({
      ...map,
      source: { treeSha256: source.treeSha256, converterVersion: source.converterVersion },
    })),
  });
}

/** Prepare a candidate without mutating the document or any external device. */
export async function preparePreset(
  document: BroadcastConfigDocument,
  request: ApplyPresetRequest,
  resolver: PresetResolver,
  newRevision: () => Revision,
): Promise<ActiveBroadcastSnapshot> {
  const preset = document.presets.find((item) => item.id === request.presetId);
  if (!preset) throw new Error('preset_missing');
  if (document.active.revision !== request.expectedActiveRevision)
    throw new Error('revision_conflict');
  const modules = boundModules(preset, document.modules);
  checkRevisions(preset, modules, request.expectedRevision, request.expectedModuleRevisions);
  const prepared = await resolver.resolve(modules);
  const moduleRevisions = { ...document.active.moduleRevisions };
  for (const kind of MODULE_KINDS) {
    if (
      effectiveModuleJson(kind, prepared.resolved[kind]) !==
      effectiveModuleJson(kind, document.active.resolved[kind])
    )
      moduleRevisions[kind] = newRevision();
  }
  return {
    schemaVersion: 1,
    revision: newRevision(),
    sourcePreset: { id: preset.id, revision: preset.revision },
    adjusted: false,
    moduleRevisions,
    resolved: structuredClone(prepared.resolved),
    lock: structuredClone(prepared.lock),
  };
}

export * from './validation.js';
