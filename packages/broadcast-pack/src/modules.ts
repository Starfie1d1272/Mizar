import { z } from 'zod';
import {
  parseModuleRecord,
  type AssetRef,
  type ModuleKind,
  type ModuleRecord,
  type MulnxToolRef,
  type ResourceRef,
} from '@mizar/broadcast-config';
import type { TemplateAssetRef } from './index.js';

export interface ExportReferences {
  asset(ref: AssetRef): TemplateAssetRef;
  resource(ref: ResourceRef): { package: string };
  tool(ref: MulnxToolRef): { package: string };
}
export interface ImportReferences {
  asset(ref: TemplateAssetRef): AssetRef;
  resource(ref: { package: string }): ResourceRef;
  tool(ref: { package: string }): MulnxToolRef;
}
export interface ModuleTemplate {
  module: ModuleKind;
  schemaVersion: number;
  name: string;
  value: unknown;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('package_invalid');
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('package_invalid');
  return value;
}
function templateRef(value: unknown, asset: boolean): { package: string; fileId?: string } {
  const ref = object(value);
  const keys = Object.keys(ref);
  if (
    keys.length !== (asset ? 2 : 1) ||
    typeof ref.package !== 'string' ||
    !/^(\$self|[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.test(ref.package) ||
    (asset &&
      (typeof ref.fileId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(ref.fileId)))
  )
    throw new Error('package_invalid');
  return ref as { package: string; fileId?: string };
}
type Convert = {
  asset(value: unknown): unknown;
  resource(value: unknown): unknown;
  tool(value: unknown): unknown;
};
function mapRecord(value: unknown, convert: (input: unknown) => unknown): ObjectValue {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, item]) => [key, convert(item)]),
  );
}
function mapTrack(value: unknown, convert: Convert): ObjectValue {
  const track = object(value);
  return { ...track, asset: convert.asset(track.asset) };
}
/** Only known reference-bearing fields are transformed; all remaining fields go to the domain parser. */
function mapValue(kind: ModuleKind, value: unknown, convert: Convert): ObjectValue {
  const module = object(value);
  if (kind === 'hud') {
    const renderer = object(module.renderer);
    if (renderer.kind === 'native') return module;
    if (renderer.kind !== 'web-hud') throw new Error('package_invalid');
    return {
      ...module,
      renderer: { ...renderer, resource: convert.resource(renderer.resource) },
      panelAssets: mapRecord(module.panelAssets, (value) => convert.asset(value)),
    };
  }
  if (kind === 'program')
    return {
      ...module,
      scenes: mapRecord(module.scenes, (item) => {
        const scene = object(item);
        return scene.kind === 'declarative'
          ? { ...scene, resource: convert.resource(scene.resource) }
          : scene;
      }),
      assets: mapRecord(module.assets, (value) => convert.asset(value)),
    };
  if (kind === 'music')
    return {
      ...module,
      groups: mapRecord(module.groups, (item) => {
        const group = object(item);
        return { ...group, tracks: array(group.tracks).map((track) => mapTrack(track, convert)) };
      }),
    };
  return {
    ...module,
    maps: array(module.maps).map((item) => {
      const map = object(item),
        source = object(map.source);
      return {
        ...map,
        source: { ...source, acquisition: convert.tool(source.acquisition) },
        openingSound: map.openingSound === null ? null : mapTrack(map.openingSound, convert),
      };
    }),
  };
}

export function exportModule(input: ModuleRecord, refs: ExportReferences): ModuleTemplate {
  const module = parseModuleRecord(input);
  const convert: Convert = {
    asset: (value) => templateRef(refs.asset(value as AssetRef), true),
    resource: (value) => templateRef(refs.resource(value as ResourceRef), false),
    tool: (value) => templateRef(refs.tool(value as MulnxToolRef), false),
  };
  return {
    module: module.kind,
    schemaVersion: module.schemaVersion,
    name: module.name,
    value: mapValue(module.kind, module.value, convert),
  };
}

export function importModule(
  input: ModuleTemplate,
  refs: ImportReferences,
  identity: { id: string; revision: string; origin: ModuleRecord['origin'] },
): ModuleRecord {
  input = z
    .strictObject({
      module: z.enum(['hud', 'program', 'music', 'camera']),
      schemaVersion: z.number().int().positive(),
      name: z.string(),
      value: z.unknown(),
    })
    .parse(input);
  const convert: Convert = {
    asset: (value) => refs.asset(templateRef(value, true) as TemplateAssetRef),
    resource: (value) => refs.resource(templateRef(value, false)),
    tool: (value) => refs.tool(templateRef(value, false)),
  };
  return parseModuleRecord({
    ...identity,
    kind: input.module,
    schemaVersion: input.schemaVersion,
    name: input.name,
    value: mapValue(input.module, input.value, convert),
  });
}
