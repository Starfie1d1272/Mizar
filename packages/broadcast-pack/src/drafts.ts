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

export type PackEntryStatus = 'ready' | 'dependency_missing' | 'unsupported' | 'invalid';
export interface PackEntryAnalysis {
  entryId: string;
  type: 'module' | 'preset';
  name: string;
  kind: string;
  status: PackEntryStatus;
  reason?: string;
  dependencies: string[];
}
export interface PackDraftInput {
  manifestBytes: Uint8Array;
  files: ReadonlyMap<string, Uint8Array>;
  source: ResourceRef;
  refs: ImportReferences;
  supports(capability: string, major: number): boolean;
  selection?: { modules: string[]; presets: string[] };
}

/** Verify the complete envelope before diagnosing individual entries. */
export function analyzePackDrafts(input: PackDraftInput): {
  entries: PackEntryAnalysis[];
  prepare(selection?: PackDraftInput['selection']): DraftBatch;
} {
  const { source } = input;
  const { manifest, digest } = parseManifest(input.manifestBytes);
  verifyFiles(manifest, input.files);
  if (source.digest !== digest || source.version !== manifest.version)
    throw new Error('package_identity_mismatch');
  const fileById = new Map(manifest.files.map((f) => [f.id, f]));
  const dependency = new Map(manifest.dependencies.map((d) => [d.alias, d]));
  const equals = (a: ResourceRef, b: ResourceRef) =>
    a.id === b.id && a.version === b.version && a.digest === b.digest;
  const read = (fileId: string): unknown => {
    const file = fileById.get(fileId);
    const bytes = file && input.files.get(file.path);
    if (!file || file.mediaType !== 'application/json' || !bytes)
      throw new Error('package_invalid');
    return parsePackJson(bytes, 256 * 1024);
  };
  const displayName = (value: unknown, fallback: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const name = (value as { name?: unknown }).name;
    if (typeof name !== 'string') return fallback;
    const trimmed = name.trim();
    return trimmed &&
      trimmed.length <= 120 &&
      [...trimmed].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      ? trimmed
      : fallback;
  };
  const requirementError = (entryId: string) =>
    manifest.requirements.some(
      (r) =>
        r.required &&
        (!r.usedBy.length || r.usedBy.includes(entryId)) &&
        !input.supports(r.capability, r.major),
    );
  const entries: PackEntryAnalysis[] = [];
  const templates = new Map<string, ReturnType<typeof importModule>>();
  const presets = new Map<string, z.infer<typeof presetTemplate>>();
  const failure = (error: unknown): { status: PackEntryStatus; reason: string } => {
    const reason = error instanceof Error ? error.message : 'package_invalid';
    if (reason === 'package_budget_exceeded') throw error;
    if (reason === 'capability_unsupported') return { status: 'unsupported', reason };
    if (reason === 'dependency_missing' || reason === 'resource_missing')
      return { status: 'dependency_missing', reason };
    return { status: 'invalid', reason: 'package_invalid' };
  };
  for (const entry of manifest.modules) {
    const analysis: PackEntryAnalysis = {
      entryId: entry.entryId,
      type: 'module',
      name: '未命名模块',
      kind: entry.module,
      status: 'ready',
      dependencies: [],
    };
    entries.push(analysis);
    try {
      const value = read(entry.fileId);
      analysis.name = displayName(value, analysis.name);
      if (
        requirementError(entry.entryId) ||
        !['hud', 'program', 'music', 'camera'].includes(entry.module)
      )
        throw new Error('capability_unsupported');
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
      const resolveResource = (alias: string) => {
        if (alias === '$self') return source;
        const item = dependency.get(alias);
        if (!item) throw new Error('dependency_missing');
        if (item.delivery.kind === 'embedded') throw new Error('capability_unsupported');
        if (!analysis.dependencies.includes(alias)) analysis.dependencies.push(alias);
        return item.resource;
      };
      const refs: ImportReferences = {
        asset(ref) {
          const expected = resolveResource(ref.package);
          if (ref.package === '$self' && !fileById.has(ref.fileId))
            throw new Error('resource_missing');
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
          if (ref.package === '$self') throw new Error('dependency_missing');
          resolveResource(ref.package);
          return input.refs.tool(ref);
        },
      };
      templates.set(
        entry.entryId,
        importModule(parsed, refs, {
          id: randomUUID(),
          revision: randomUUID(),
          origin: { resource: source, entryId: entry.entryId },
        }),
      );
    } catch (error) {
      Object.assign(analysis, failure(error));
    }
  }
  for (const entry of manifest.presets) {
    const analysis: PackEntryAnalysis = {
      entryId: entry.entryId,
      type: 'preset',
      name: '未命名方案',
      kind: 'preset',
      status: 'ready',
      dependencies: [],
    };
    entries.push(analysis);
    try {
      const value = read(entry.fileId);
      analysis.name = displayName(value, analysis.name);
      if (requirementError(entry.entryId)) throw new Error('capability_unsupported');
      const template = presetTemplate.parse(value);
      const modules: ModuleRecord[] = [];
      const bindings = template.bindings.map((binding) => {
        if (binding.mode === 'off') return binding;
        analysis.dependencies.push(binding.entryId);
        const module = templates.get(binding.entryId);
        if (!module || module.kind !== binding.kind) throw new Error('dependency_missing');
        const copy = structuredClone(module);
        copy.id = randomUUID();
        modules.push(copy);
        return { kind: binding.kind, mode: 'use' as const, moduleId: copy.id };
      });
      const preset = parseBroadcastPreset({
        schemaVersion: 1,
        id: randomUUID(),
        revision: randomUUID(),
        name: template.name,
        origin: { resource: source, entryId: entry.entryId },
        opaqueModules: [],
        bindings,
      });
      boundModules(preset, modules);
      presets.set(entry.entryId, template);
    } catch (error) {
      Object.assign(analysis, failure(error));
    }
  }
  return {
    entries,
    prepare(selection = input.selection) {
      const selected = selection ?? {
        modules: manifest.modules.map((entry) => entry.entryId),
        presets: manifest.presets.map((entry) => entry.entryId),
      };
      if (
        new Set(selected.modules).size !== selected.modules.length ||
        new Set(selected.presets).size !== selected.presets.length ||
        selected.modules.some((id) => !manifest.modules.some((entry) => entry.entryId === id)) ||
        selected.presets.some((id) => !manifest.presets.some((entry) => entry.entryId === id))
      )
        throw new Error('invalid_selection');
      const modules: ModuleRecord[] = [],
        resultPresets: BroadcastPreset[] = [];
      const moduleEntries: Record<string, string[]> = Object.create(null) as Record<
        string,
        string[]
      >;
      const presetEntries: Record<string, string> = Object.create(null) as Record<string, string>;
      const create = (entryId: string, kind?: ModuleKind) => {
        const original = templates.get(entryId);
        if (!original || (kind && original.kind !== kind)) throw new Error('module_missing');
        const module = structuredClone(original);
        module.id = randomUUID();
        module.revision = randomUUID();
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
      for (const entryId of selected.presets) {
        const template = presets.get(entryId);
        if (!template) continue;
        const preset = parseBroadcastPreset({
          schemaVersion: 1,
          id: randomUUID(),
          revision: randomUUID(),
          name: template.name,
          origin: { resource: source, entryId },
          opaqueModules: [],
          bindings: template.bindings.map((b) =>
            b.mode === 'off'
              ? b
              : { kind: b.kind, mode: 'use', moduleId: create(b.entryId, b.kind) },
          ),
        });
        boundModules(preset, modules);
        resultPresets.push(preset);
        presetEntries[entryId] = preset.id;
      }
      for (const entryId of selected.modules)
        if (templates.has(entryId) && !moduleEntries[entryId]) create(entryId);
      return { source, modules, presets: resultPresets, moduleEntries, presetEntries };
    },
  };
}

/** Construct independent draft objects from selected, valid entries. */
export function preparePackDrafts(input: PackDraftInput): DraftBatch {
  return analyzePackDrafts(input).prepare();
}
