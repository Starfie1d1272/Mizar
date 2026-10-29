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
/** Content identity is independent of the release from which it was obtained. */
export interface CameraSourceRef {
  sourceName: string;
  treeSha256: string;
  converterVersion: 1;
  release: MulnxReleaseRef;
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
  | { renderer: 'native'; config: HudResolvedPreset }
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
  lock: { resources: ResourceRef[]; tools: MulnxReleaseRef[] };
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
