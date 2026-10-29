import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  boundModules,
  parseBroadcastPreset,
  type BroadcastPreset,
  type ModuleKind,
  type ModuleRecord,
  type ResourceRef,
} from '@mizar/broadcast-config';
import { parseManifest, parsePackJson, verifyFiles } from './index.js';
import { importModule, type ImportReferences } from './modules.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const binding = z.discriminatedUnion('mode', [
  z.strictObject({
    kind: z.enum(['hud', 'program', 'music', 'camera']),
    mode: z.literal('use'),
    entryId: id,
  }),
  z.strictObject({ kind: z.enum(['hud', 'program', 'music', 'camera']), mode: z.literal('off') }),
]);
const presetTemplate = z.strictObject({
  name: z.string().trim().min(1).max(120),
  bindings: z.array(binding).length(4),
});
export interface DraftBatch {
  source: ResourceRef;
  modules: ModuleRecord[];
  presets: BroadcastPreset[];
  moduleEntries: Record<string, string[]>;
  presetEntries: Record<string, string>;
}

/** Construct independent draft objects only after the source and dependencies were installed by their owners. */
export function preparePackDrafts(input: {
  manifestBytes: Uint8Array;
  files: ReadonlyMap<string, Uint8Array>;
  source: ResourceRef;
  refs: ImportReferences;
  supports(capability: string, major: number): boolean;
}): DraftBatch {
  const { source } = input;
  const { manifest, digest } = parseManifest(input.manifestBytes);
  verifyFiles(manifest, input.files);
  if (source.digest !== digest || source.version !== manifest.version)
    throw new Error('package_identity_mismatch');
  if (manifest.requirements.some((r) => r.required && !input.supports(r.capability, r.major)))
    throw new Error('capability_unsupported');
  // Embedded archives require their provider and shared budget; do not treat them as ordinary files.
  if (manifest.dependencies.some((d) => d.delivery.kind === 'embedded'))
    throw new Error('capability_unsupported');
  const fileById = new Map(manifest.files.map((f) => [f.id, f]));
  const dependency = new Map(manifest.dependencies.map((d) => [d.alias, d.resource]));
  const resolveResource = (alias: string) => {
    const resource = alias === '$self' ? source : dependency.get(alias);
    if (!resource) throw new Error('dependency_missing');
    return resource;
  };
  const equals = (a: ResourceRef, b: ResourceRef) =>
    a.id === b.id && a.version === b.version && a.digest === b.digest;
  const refs: ImportReferences = {
    asset(ref) {
      const expected = resolveResource(ref.package);
      if (ref.package === '$self' && !fileById.has(ref.fileId)) throw new Error('resource_missing');
      const result = input.refs.asset(ref);
      if (!equals(result.resource, expected) || result.fileId !== ref.fileId)
        throw new Error('package_identity_mismatch');
      return result;
    },
    resource(ref) {
      const expected = resolveResource(ref.package),
        result = input.refs.resource(ref);
      if (!equals(result, expected)) throw new Error('package_identity_mismatch');
      return result;
    },
    tool(ref) {
      if (ref.package === '$self' || !dependency.has(ref.package))
        throw new Error('dependency_missing');
      return input.refs.tool(ref);
    },
  };
  const read = (fileId: string): unknown => {
    const file = fileById.get(fileId);
    const bytes = file && input.files.get(file.path);
    if (!file || file.mediaType !== 'application/json' || !bytes)
      throw new Error('package_invalid');
    return parsePackJson(bytes, 256 * 1024);
  };
  const templates = new Map(
    manifest.modules.map((entry) => {
      if (!['hud', 'program', 'music', 'camera'].includes(entry.module))
        throw new Error('capability_unsupported');
      const value = read(entry.fileId);
      const parsed = z
        .strictObject({
          module: z.enum(['hud', 'program', 'music', 'camera']),
          schemaVersion: z.number().int().positive(),
          name: z.string(),
          value: z.unknown(),
        })
        .parse(value);
      if (parsed.module !== entry.module || parsed.schemaVersion !== entry.schemaVersion)
        throw new Error('package_invalid');
      return [entry.entryId, parsed] as const;
    }),
  );
  const modules: ModuleRecord[] = [],
    presets: BroadcastPreset[] = [];
  const moduleEntries: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const presetEntries: Record<string, string> = Object.create(null) as Record<string, string>;
  const create = (entryId: string, kind?: ModuleKind) => {
    const template = templates.get(entryId);
    if (!template || (kind && template.module !== kind)) throw new Error('module_missing');
    const module = importModule(template, refs, {
      id: randomUUID(),
      revision: randomUUID(),
      origin: { resource: source, entryId },
    });
    if (module.kind === 'hud' && 'preset' in module.value) {
      module.value.layout.id = randomUUID();
      module.value.theme.id = randomUUID();
      module.value.preset.id = randomUUID();
      module.value.preset.layoutId = module.value.layout.id;
      module.value.preset.themeId = module.value.theme.id;
    }
    modules.push(module);
    (moduleEntries[entryId] ??= []).push(module.id);
    return module.id;
  };
  for (const entry of manifest.presets) {
    const template = presetTemplate.parse(read(entry.fileId));
    const preset = parseBroadcastPreset({
      schemaVersion: 1,
      id: randomUUID(),
      revision: randomUUID(),
      name: template.name,
      origin: { resource: source, entryId: entry.entryId },
      opaqueModules: [],
      bindings: template.bindings.map((b) =>
        b.mode === 'off' ? b : { kind: b.kind, mode: 'use', moduleId: create(b.entryId, b.kind) },
      ),
    });
    boundModules(preset, modules);
    presets.push(preset);
    presetEntries[entry.entryId] = preset.id;
  }
  for (const entry of manifest.modules) if (!moduleEntries[entry.entryId]) create(entry.entryId);
  return { source, modules, presets, moduleEntries, presetEntries };
}
