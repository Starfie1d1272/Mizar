import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { canonicalJson } from '@mizar/hud-config';
import { z } from 'zod';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import {
  boundModules,
  assertSupportedHudModule,
  isSupportedHudPauseVisual,
  clonePreset,
  preparePreset,
  parseBroadcastConfigDocument,
  resourceRefSchema,
  sameEffectiveModule,
  type ActiveBroadcastSnapshot,
  type ApplyPresetRequest,
  type BroadcastConfigDocument,
  type ClonePresetRequest,
  type BroadcastPreset,
  type ModuleRecord,
  type Revision,
  type PresetResolver,
  type ResourceRef,
  type ModuleKind,
  type CameraModuleV2,
} from '@mizar/broadcast-config';
import { durableJsonByteLength, replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import {
  addMissingBuiltinModules,
  BUILTIN_MODULE_IDS,
  isBuiltinModuleId,
} from './builtin-modules.js';
import { broadcastResourceReferences } from './reference-queue.js';
import { cameraCatalogSchema } from '../orchestration/store.js';

interface Receipt {
  fingerprint: string;
  active: ActiveBroadcastSnapshot;
}
const importEntry = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const importMappingSchema = z.strictObject({
  source: resourceRefSchema,
  moduleEntries: z.record(importEntry, z.array(z.string().uuid()).min(1).max(128)),
  presetEntries: z.record(importEntry, z.string().uuid()),
  moduleOwners: z.record(z.string().uuid(), importEntry.nullable()).optional(),
});
export type BroadcastImportMapping = z.infer<typeof importMappingSchema>;
/** The caller must have installed and verified source before invoking this operation. */
export interface BroadcastImportBatch {
  source: ResourceRef;
  modules: ModuleRecord[];
  presets: BroadcastPreset[];
  moduleEntries: Record<string, string[]>;
  presetEntries: Record<string, string>;
}
interface Envelope {
  version: 1;
  document: BroadcastConfigDocument;
  receipts: Record<string, Receipt>;
  imports: BroadcastImportMapping[];
  builtinsNormalized?: boolean | undefined;
  pendingLegacyCamera?: PendingLegacyCamera | undefined;
  restoredLegacyCamera?:
    Array<{ legacyId: string; moduleId: string; activeSnapshot: boolean }> | undefined;
}
const pendingLegacyCameraSchema = z.strictObject({
  catalog: cameraCatalogSchema,
  automaticEnabled: z.boolean(),
  reason: z.literal('camera_identity_unavailable'),
});
export type PendingLegacyCamera = z.infer<typeof pendingLegacyCameraSchema>;
const restoredLegacyCameraSchema = z
  .array(z.strictObject({ legacyId: z.uuid(), moduleId: z.uuid(), activeSnapshot: z.boolean() }))
  .max(33);

/** Parsing must use the registered domain codecs, including their resolved snapshot parsers. */
export interface BroadcastConfigStoreOptions {
  filePath: string;
  createInitial(): Promise<BroadcastConfigDocument>;
  initialPendingLegacyCamera?(): PendingLegacyCamera | undefined;
  resolver: PresetResolver;
  /** Serializes changes to resource references with provider removal. */
  withReferenceGuard<T>(operation: () => Promise<T>): Promise<T>;
  /** Reject references being added to versions marked for deletion; missing external dependencies may remain drafts. */
  assertReferenceCommitAllowed(
    previous: BroadcastConfigDocument,
    next: BroadcastConfigDocument,
  ): Promise<void>;
  /** Verify all references and capabilities in an individually adjusted active snapshot. */
  verifyLegacyActive(active: ActiveBroadcastSnapshot, kind?: ModuleKind): Promise<void>;
  /** Holds the production lifecycle and exposes a synchronous final readiness check. */
  withApplyGuard<T>(operation: (canCommit: () => boolean) => Promise<T>): Promise<T>;
  onApplied?(
    active: ActiveBroadcastSnapshot,
    previous: ActiveBroadcastSnapshot,
    kind?: ModuleKind,
  ): void | Promise<void>;
  resolveModule?(module: ModuleRecord): Promise<{
    value: ActiveBroadcastSnapshot['resolved'][ModuleKind];
    lock: ActiveBroadcastSnapshot['lock'];
  }>;
  onDraftChanged?(kind: ModuleKind): Promise<void>;
  validateHudDraft?(document: BroadcastConfigDocument): void;
}

export class BroadcastConfigStore {
  private readonly queue = new SerialCommitQueue();
  private readonly applyQueue = new SerialCommitQueue();
  private applying = false;
  get isApplying(): boolean {
    return this.applying;
  }
  waitForApply(): Promise<void> {
    return this.applyQueue.flush();
  }
  private envelope: Envelope | null = null;
  constructor(private readonly options: BroadcastConfigStoreOptions) {}

  private parseEnvelope(input: unknown): Envelope {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('broadcast_config_invalid');
    const value = input as Record<string, unknown>;
    if (
      value.version !== 1 ||
      !value.receipts ||
      typeof value.receipts !== 'object' ||
      Array.isArray(value.receipts) ||
      Object.keys(value).some(
        (key) =>
          ![
            'version',
            'document',
            'receipts',
            'imports',
            'builtinsNormalized',
            'pendingLegacyCamera',
            'restoredLegacyCamera',
          ].includes(key),
      )
    )
      throw new Error('broadcast_config_invalid');
    const document = parseBroadcastConfigDocument(value.document);
    const receipts: Record<string, Receipt> = Object.create(null) as Record<string, Receipt>;
    for (const [id, raw] of Object.entries(value.receipts)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('broadcast_config_invalid');
      const receipt = raw as Record<string, unknown>;
      if (
        typeof receipt.fingerprint !== 'string' ||
        Object.keys(receipt).some((key) => !['fingerprint', 'active'].includes(key))
      )
        throw new Error('broadcast_config_invalid');
      // Reuse the same domain parser for the persisted receipt's resolved snapshot.
      const checked = parseBroadcastConfigDocument({ ...document, active: receipt.active });
      receipts[id] = { fingerprint: receipt.fingerprint, active: checked.active };
    }
    const imports = z
      .array(importMappingSchema)
      .max(4096)
      .parse(value.imports ?? []);
    const identities = imports.map((entry) =>
      canonicalJson([entry.source.id, entry.source.version]),
    );
    if (new Set(identities).size !== identities.length) throw new Error('broadcast_config_invalid');
    for (const mapping of imports) {
      const seen = new Set<string>();
      for (const [entryId, ids] of Object.entries(mapping.moduleEntries)) {
        for (const id of ids) {
          if (seen.has(id) || isBuiltinModuleId(id))
            throw new Error('broadcast_import_index_invalid');
          seen.add(id);
          const module = document.modules.find((item) => item.id === id);
          if (
            module &&
            (!module.origin ||
              module.origin.entryId !== entryId ||
              canonicalJson(module.origin.resource) !== canonicalJson(mapping.source))
          )
            throw new Error('broadcast_import_index_invalid');
        }
      }
      for (const [entryId, id] of Object.entries(mapping.presetEntries)) {
        if (seen.has(id)) throw new Error('broadcast_import_index_invalid');
        seen.add(id);
        const preset = document.presets.find((item) => item.id === id);
        if (
          preset &&
          (!preset.origin ||
            preset.origin.entryId !== entryId ||
            canonicalJson(preset.origin.resource) !== canonicalJson(mapping.source))
        )
          throw new Error('broadcast_import_index_invalid');
      }
      if (
        Object.keys(mapping.moduleOwners ?? {}).some(
          (id) => !Object.values(mapping.moduleEntries).some((ids) => ids.includes(id)),
        ) ||
        Object.values(mapping.moduleOwners ?? {}).some(
          (owner) => owner !== null && !(owner in mapping.presetEntries),
        )
      )
        throw new Error('broadcast_import_index_invalid');
    }
    const pendingLegacyCamera = pendingLegacyCameraSchema
      .optional()
      .parse(value.pendingLegacyCamera);
    const restoredLegacyCamera = restoredLegacyCameraSchema
      .optional()
      .parse(value.restoredLegacyCamera);
    const builtinsNormalized = z.boolean().optional().parse(value.builtinsNormalized);
    return {
      version: 1,
      document,
      receipts,
      imports,
      ...(builtinsNormalized !== undefined ? { builtinsNormalized } : {}),
      ...(pendingLegacyCamera ? { pendingLegacyCamera } : {}),
      ...(restoredLegacyCamera ? { restoredLegacyCamera } : {}),
    };
  }
  private async read(): Promise<Envelope> {
    const stat = await lstat(this.options.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
      throw new Error('broadcast_config_invalid');
    return this.parseEnvelope(JSON.parse(await readFile(this.options.filePath, 'utf8')));
  }
  async load(): Promise<void> {
    await this.queue.run(async () => {
      try {
        this.envelope = await this.read();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const document = parseBroadcastConfigDocument(await this.options.createInitial());
        const pendingLegacyCamera = this.options.initialPendingLegacyCamera?.();
        const initial: Envelope = {
          version: 1,
          document,
          receipts: {},
          imports: [],
          ...(pendingLegacyCamera ? { pendingLegacyCamera } : {}),
        };
        if (durableJsonByteLength(initial) > 16 * 1024 * 1024)
          throw new Error('broadcast_config_too_large', { cause: error });
        await replaceDurableJson(this.options.filePath, initial);
        this.envelope = await this.read();
      }
      const next = structuredClone(this.envelope);
      if (!next.builtinsNormalized) {
        addMissingBuiltinModules(next.document);
        next.builtinsNormalized = true;
        await this.commit(next);
      } else if (addMissingBuiltinModules(next.document, false)) await this.commit(next);
    });
  }
  async addBuiltinMusic(module: ModuleRecord<'music'>): Promise<void> {
    await this.queue.run(async () => {
      if (!this.envelope || module.id !== BUILTIN_MODULE_IDS.music)
        throw new Error('broadcast_config_invalid');
      if (this.envelope.document.modules.some((item) => item.id === module.id)) return;
      const next = structuredClone(this.envelope);
      next.document.modules.push(module);
      await this.commit(next);
    });
  }
  hasReceipt(requestId: string): boolean {
    return Object.hasOwn(this.envelope?.receipts ?? {}, requestId);
  }
  get snapshot(): BroadcastConfigDocument {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    return structuredClone(this.envelope.document);
  }
  /** Include resources exposed by durable apply receipts as well as the current document. */
  referencedResources(): ResourceRef[] {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    const refs = new Map(
      broadcastResourceReferences(this.envelope.document).map((ref) => [canonicalJson(ref), ref]),
    );
    for (const receipt of Object.values(this.envelope.receipts))
      for (const ref of receipt.active.lock.resources) refs.set(canonicalJson(ref), ref);
    return structuredClone([...refs.values()]);
  }
  get pendingLegacyCamera(): PendingLegacyCamera | undefined {
    return structuredClone(this.envelope?.pendingLegacyCamera);
  }
  /** Read-only hints for package inspection; importBatch rechecks under the commit queue. */
  inspectImport(source: ResourceRef): {
    modules: Record<
      string,
      Array<{ id: string; owner: string | null; state: 'existing' | 'removed' }>
    >;
    presets: Record<string, { id: string; state: 'existing' | 'removed' }>;
  } | null {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    const mapping = this.envelope.imports.find(
      (entry) => entry.source.id === source.id && entry.source.version === source.version,
    );
    if (!mapping) return null;
    if (mapping.source.digest !== source.digest) throw new Error('identity_conflict');
    const owners = { ...mapping.moduleOwners };
    for (const [entryId, presetId] of Object.entries(mapping.presetEntries)) {
      const preset = this.envelope.document.presets.find((item) => item.id === presetId);
      for (const binding of preset?.bindings ?? [])
        if (
          binding.mode === 'use' &&
          Object.values(mapping.moduleEntries).some((ids) => ids.includes(binding.moduleId))
        )
          if (!Object.hasOwn(owners, binding.moduleId)) owners[binding.moduleId] = entryId;
    }
    const modules = Object.fromEntries(
      Object.entries(mapping.moduleEntries).map(([entryId, ids]) => [
        entryId,
        ids.map((id) => ({
          id,
          owner: owners[id] ?? null,
          state: this.envelope!.document.modules.some((item) => item.id === id)
            ? ('existing' as const)
            : ('removed' as const),
        })),
      ]),
    );
    const presets = Object.fromEntries(
      Object.entries(mapping.presetEntries).map(([entryId, id]) => [
        entryId,
        {
          id,
          state: this.envelope!.document.presets.some((item) => item.id === id)
            ? ('existing' as const)
            : ('removed' as const),
        },
      ]),
    );
    return { modules, presets };
  }
  async restoreLegacyCamera(
    convert: (
      preset: PendingLegacyCamera['catalog']['preset'],
      automaticEnabled: boolean,
    ) => Promise<CameraModuleV2>,
  ): Promise<Array<{ legacyId: string; moduleId: string; activeSnapshot: boolean }>> {
    return this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope?.pendingLegacyCamera) throw new Error('pending_camera_missing');
        const pending = this.envelope.pendingLegacyCamera;
        const modules: ModuleRecord<'camera'>[] = [];
        const originals = pending.catalog.presets.map((item) => ({
          ...item,
          activeSnapshot: false,
        }));
        const activeDraft = originals.find((item) => item.id === pending.catalog.activePresetId);
        if (
          !activeDraft ||
          canonicalJson(activeDraft.preset) !== canonicalJson(pending.catalog.preset)
        )
          originals.push({
            id: pending.catalog.activePresetId,
            preset: pending.catalog.preset,
            activeSnapshot: true,
          });
        for (const item of originals) {
          const value = await convert(item.preset, pending.automaticEnabled);
          const module: ModuleRecord<'camera'> = {
            id: randomUUID(),
            revision: randomUUID(),
            kind: 'camera',
            schemaVersion: 2,
            name: item.preset.name,
            value,
            origin: null,
          };
          if (!this.options.resolveModule) throw new Error('camera_identity_unavailable');
          await this.options.resolveModule(module);
          modules.push(module);
        }
        const next = structuredClone(this.envelope);
        next.document.modules.push(...modules);
        next.restoredLegacyCamera = modules.map((module, index) => ({
          legacyId: originals[index]!.id,
          moduleId: module.id,
          activeSnapshot: originals[index]!.activeSnapshot,
        }));
        delete next.pendingLegacyCamera;
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return next.restoredLegacyCamera;
      }),
    );
  }
  async deletePendingLegacyCamera(): Promise<void> {
    await this.queue.run(async () => {
      if (!this.envelope?.pendingLegacyCamera) throw new Error('pending_camera_missing');
      const next = structuredClone(this.envelope);
      delete next.pendingLegacyCamera;
      await this.commit(next);
    });
  }
  private async commit(next: Envelope, canCommit?: () => boolean): Promise<void> {
    const checked = this.parseEnvelope(next);
    if (durableJsonByteLength(checked) > 16 * 1024 * 1024)
      throw new Error('broadcast_config_too_large');
    const committed = await replaceDurableJson(
      this.options.filePath,
      checked,
      canCommit ? { canCommit } : {},
    );
    if (!committed) throw new Error('production_busy');
    this.envelope = checked;
  }
  async clone(request: ClonePresetRequest): Promise<{ presetId: string }> {
    const result = await this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const next = structuredClone(this.envelope);
        const copy = clonePreset(next.document, request, randomUUID);
        copy.modules.forEach(assertSupportedHudModule);
        next.document.modules.push(...copy.modules);
        next.document.presets.push(copy.preset);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return {
          presetId: copy.preset.id,
          hasHud: copy.modules.some((item) => item.kind === 'hud'),
        };
      }),
    );
    if (result.hasHud) await this.options.onDraftChanged?.('hud');
    return { presetId: result.presetId };
  }
  /** Atomically installs drafts and their entry mapping without changing active configuration. */
  async importBatch(
    input: BroadcastImportBatch,
  ): Promise<{ mapping: BroadcastImportMapping; reused: boolean }> {
    const result = await this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        input.modules.forEach(assertSupportedHudModule);
        const mapping = importMappingSchema.parse({
          source: input.source,
          moduleEntries: input.moduleEntries,
          presetEntries: input.presetEntries,
        });
        const existing = this.envelope.imports.find(
          (entry) =>
            entry.source.id === mapping.source.id &&
            entry.source.version === mapping.source.version,
        );
        if (existing) {
          if (existing.source.digest !== mapping.source.digest)
            throw new Error('identity_conflict');
        }
        const moduleIds = input.modules.map((item) => item.id);
        const presetIds = input.presets.map((item) => item.id);
        const mappedModules = Object.values(mapping.moduleEntries).flat();
        const mappedPresets = Object.values(mapping.presetEntries);
        const sameIds = (actual: string[], mapped: string[]) =>
          actual.length === mapped.length &&
          new Set(actual).size === actual.length &&
          new Set(mapped).size === mapped.length &&
          actual.every((id) => mapped.includes(id));
        if (
          (!moduleIds.length && !presetIds.length) ||
          moduleIds.some(isBuiltinModuleId) ||
          !sameIds(moduleIds, mappedModules) ||
          !sameIds(presetIds, mappedPresets)
        )
          throw new Error('invalid_import_mapping');
        const used = new Set<string>();
        const owners = new Map<string, string | null>();
        for (const [entryId, presetId] of Object.entries(mapping.presetEntries)) {
          const preset = input.presets.find((item) => item.id === presetId)!;
          for (const binding of preset.bindings)
            if (binding.mode === 'use') {
              if (!moduleIds.includes(binding.moduleId) || used.has(binding.moduleId))
                throw new Error('invalid_import_mapping');
              used.add(binding.moduleId);
              owners.set(binding.moduleId, entryId);
            }
        }
        for (const id of moduleIds) if (!owners.has(id)) owners.set(id, null);
        const next = structuredClone(this.envelope);
        const result = existing
          ? structuredClone(existing)
          : { ...mapping, moduleEntries: {}, presetEntries: {}, moduleOwners: {} };
        result.moduleOwners ??= {};
        // Older indices did not record ownership; infer it only from the currently bound presets.
        for (const [entryId, presetId] of Object.entries(result.presetEntries)) {
          const preset = next.document.presets.find((item) => item.id === presetId);
          for (const binding of preset?.bindings ?? [])
            if (
              binding.mode === 'use' &&
              Object.values(result.moduleEntries).some((ids) => ids.includes(binding.moduleId))
            )
              if (!Object.hasOwn(result.moduleOwners, binding.moduleId))
                result.moduleOwners[binding.moduleId] = entryId;
        }
        const substitutions = new Map<string, string>();
        let added = false;
        for (const [entryId, incomingIds] of Object.entries(mapping.moduleEntries)) {
          const oldIds = result.moduleEntries[entryId] ?? [];
          for (const incomingId of incomingIds) {
            const owner = owners.get(incomingId) ?? null;
            // A standalone selection may reuse any live copy of the selected entry.
            // Scheme-owned selections still require their own independently editable copy.
            const live = next.document.modules.find(
              (item) =>
                oldIds.includes(item.id) &&
                (owner === null || (result.moduleOwners?.[item.id] ?? null) === owner),
            );
            if (live) {
              substitutions.set(incomingId, live.id);
              continue;
            }
            const prior = oldIds.find((id) => (result.moduleOwners?.[id] ?? null) === owner);
            const module = input.modules.find((item) => item.id === incomingId)!;
            if (
              isBuiltinModuleId(module.id) ||
              next.document.modules.some((item) => item.id === module.id)
            )
              throw new Error('invalid_import_mapping');
            next.document.modules.push(structuredClone(module));
            if (prior) {
              oldIds.splice(oldIds.indexOf(prior), 1);
              delete result.moduleOwners[prior];
            }
            oldIds.push(module.id);
            result.moduleOwners[module.id] = owner;
            substitutions.set(incomingId, module.id);
            added = true;
          }
          result.moduleEntries[entryId] = oldIds;
        }
        for (const [entryId, presetId] of Object.entries(mapping.presetEntries)) {
          const prior = result.presetEntries[entryId];
          if (prior && next.document.presets.some((item) => item.id === prior)) continue;
          const preset = structuredClone(input.presets.find((item) => item.id === presetId)!);
          if (next.document.presets.some((item) => item.id === preset.id))
            throw new Error('invalid_import_mapping');
          preset.bindings = preset.bindings.map((binding) =>
            binding.mode === 'use'
              ? { ...binding, moduleId: substitutions.get(binding.moduleId)! }
              : binding,
          );
          next.document.presets.push(preset);
          result.presetEntries[entryId] = preset.id;
          added = true;
        }
        if (!added && existing) return { mapping: result, reused: true };
        next.imports = next.imports.filter(
          (entry) =>
            !(
              entry.source.id === mapping.source.id &&
              entry.source.version === mapping.source.version
            ),
        );
        next.imports.push(result);
        if (input.modules.some((item) => item.kind === 'hud'))
          this.options.validateHudDraft?.(next.document);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return { mapping: structuredClone(result), reused: false };
      }),
    );
    if (input.modules.some((item) => item.kind === 'hud'))
      await this.options.onDraftChanged?.('hud');
    return result;
  }
  /** Saves the preset and its edited modules in one draft-only commit. */
  async save(input: {
    preset: BroadcastPreset;
    expectedPresetRevision: Revision | null;
    modules: { value: ModuleRecord; expectedRevision: Revision | null }[];
  }): Promise<BroadcastConfigDocument> {
    const result = await this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const next = structuredClone(this.envelope);
        const oldPreset = next.document.presets.find((item) => item.id === input.preset.id);
        if ((oldPreset?.revision ?? null) !== input.expectedPresetRevision)
          throw new Error('revision_conflict');
        const seen = new Set<string>();
        for (const update of input.modules) {
          assertSupportedHudModule(update.value);
          if (isBuiltinModuleId(update.value.id)) throw new Error('builtin_immutable');
          if (seen.has(update.value.id)) throw new Error('duplicate_module');
          seen.add(update.value.id);
          const index = next.document.modules.findIndex((item) => item.id === update.value.id);
          const old = next.document.modules[index];
          if (
            (old?.revision ?? null) !== update.expectedRevision ||
            (old && old.kind !== update.value.kind)
          )
            throw new Error('revision_conflict');
          const value = structuredClone(update.value);
          value.revision =
            old &&
            canonicalJson({ ...old, revision: '' }) === canonicalJson({ ...value, revision: '' })
              ? old.revision
              : randomUUID();
          if (index < 0) next.document.modules.push(value);
          else next.document.modules[index] = value;
        }
        const preset = structuredClone(input.preset);
        preset.revision =
          oldPreset &&
          canonicalJson({ ...oldPreset, revision: '' }) ===
            canonicalJson({ ...preset, revision: '' })
            ? oldPreset.revision
            : randomUUID();
        const index = next.document.presets.findIndex((item) => item.id === preset.id);
        if (index < 0) next.document.presets.push(preset);
        else next.document.presets[index] = preset;
        for (const item of next.document.presets) boundModules(item, next.document.modules);
        if (input.modules.some((item) => item.value.kind === 'hud'))
          this.options.validateHudDraft?.(next.document);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return this.snapshot;
      }),
    );
    if (input.modules.some((item) => item.value.kind === 'hud'))
      await this.options.onDraftChanged?.('hud');
    return result;
  }
  async saveModule(value: ModuleRecord, expectedRevision: Revision | null): Promise<ModuleRecord> {
    const saved = await this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        if (isBuiltinModuleId(value.id)) throw new Error('builtin_immutable');
        assertSupportedHudModule(value);
        const next = structuredClone(this.envelope);
        const index = next.document.modules.findIndex((item) => item.id === value.id);
        const old = next.document.modules[index];
        if ((old?.revision ?? null) !== expectedRevision || (old && old.kind !== value.kind))
          throw new Error('revision_conflict');
        const saved = structuredClone(value);
        saved.revision =
          old &&
          canonicalJson({ ...old, revision: '' }) === canonicalJson({ ...saved, revision: '' })
            ? old.revision
            : randomUUID();
        if (index < 0) next.document.modules.push(saved);
        else next.document.modules[index] = saved;
        if (saved.kind === 'hud') this.options.validateHudDraft?.(next.document);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return structuredClone(saved);
      }),
    );
    await this.options.onDraftChanged?.(saved.kind);
    return saved;
  }
  async cloneModule(id: string, expectedRevision: Revision, name: string): Promise<ModuleRecord> {
    const copy = await this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const source = this.envelope.document.modules.find((item) => item.id === id);
        if (!source) throw new Error('module_missing');
        if (source.revision !== expectedRevision) throw new Error('revision_conflict');
        assertSupportedHudModule(source);
        const copy = structuredClone(source);
        copy.id = randomUUID();
        copy.revision = randomUUID();
        copy.name = name;
        copy.origin = null;
        if (copy.kind === 'hud' && 'preset' in copy.value) {
          const { preset, layout, theme } = copy.value;
          preset.id = randomUUID();
          layout.id = randomUUID();
          theme.id = randomUUID();
          preset.layoutId = layout.id;
          preset.themeId = theme.id;
          preset.name = name;
        }
        const next = structuredClone(this.envelope);
        next.document.modules.push(copy);
        if (copy.kind === 'hud') this.options.validateHudDraft?.(next.document);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return structuredClone(copy);
      }),
    );
    await this.options.onDraftChanged?.(copy.kind);
    return copy;
  }
  async deleteModule(
    id: string,
    expectedRevision: Revision,
    replacement?: { moduleId: string | null; expectedPresetRevisions: Record<string, Revision> },
  ): Promise<void> {
    const kind = await this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        if (isBuiltinModuleId(id)) throw new Error('builtin_immutable');
        const item = this.envelope.document.modules.find((module) => module.id === id);
        if (!item) throw new Error('module_missing');
        if (item.revision !== expectedRevision) throw new Error('revision_conflict');
        if (Object.values(this.envelope.document.active.sourceModuleIds ?? {}).includes(id))
          throw new Error('module_active');
        if (
          this.envelope.document.active.sourceModuleIds?.[item.kind] === undefined &&
          this.envelope.document.presets.some(
            (preset) =>
              preset.id === this.envelope!.document.active.sourcePreset?.id &&
              preset.bindings.some((binding) => binding.mode === 'use' && binding.moduleId === id),
          )
        )
          throw new Error('module_active');
        const next = structuredClone(this.envelope);
        const usages = next.document.presets.filter((preset) =>
          preset.bindings.some((binding) => binding.mode === 'use' && binding.moduleId === id),
        );
        if (usages.length && !replacement) throw new Error('module_referenced');
        if (replacement && usages.length) {
          const substitute =
            replacement.moduleId === null
              ? null
              : next.document.modules.find((module) => module.id === replacement.moduleId);
          if (
            (replacement.moduleId !== null &&
              (!substitute || substitute.id === id || substitute.kind !== item.kind)) ||
            (replacement.moduleId === null && (item.kind === 'hud' || item.kind === 'program'))
          )
            throw new Error('invalid_request');
          for (const preset of usages) {
            if (replacement.expectedPresetRevisions[preset.id] !== preset.revision)
              throw new Error('revision_conflict');
            preset.bindings = preset.bindings.map((binding) =>
              binding.mode === 'use' && binding.moduleId === id
                ? substitute
                  ? { kind: binding.kind, mode: 'use' as const, moduleId: substitute.id }
                  : { kind: binding.kind, mode: 'off' as const }
                : binding,
            );
            preset.revision = randomUUID();
          }
        }
        next.document.modules = next.document.modules.filter((module) => module.id !== id);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return item.kind;
      }),
    );
    await this.options.onDraftChanged?.(kind);
  }
  async deletePreset(id: string, expectedRevision: Revision): Promise<void> {
    return this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const item = this.envelope.document.presets.find((preset) => preset.id === id);
        if (!item) throw new Error('preset_missing');
        if (item.revision !== expectedRevision) throw new Error('revision_conflict');
        if (this.envelope.document.active.sourcePreset?.id === id) throw new Error('preset_active');
        const next = structuredClone(this.envelope);
        next.document.presets = next.document.presets.filter((preset) => preset.id !== id);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
      }),
    );
  }
  async applyModule(input: {
    moduleId: string;
    expectedRevision: Revision;
    expectedActiveRevision: Revision;
    requestId: string;
  }): Promise<ActiveBroadcastSnapshot> {
    return this.applyQueue.run(async () => {
      this.applying = true;
      try {
        const result = await this.queue.run(async () => {
          if (!this.envelope || !this.options.resolveModule)
            throw new Error('broadcast_config_unavailable');
          const fingerprint = canonicalJson({ action: 'module', ...input });
          const receipt = this.envelope.receipts[input.requestId];
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new Error('request_conflict');
            const module = this.envelope.document.modules.find(
              (item) => item.id === input.moduleId,
            );
            const kind =
              module?.kind ??
              (Object.entries(receipt.active.sourceModuleIds ?? {}).find(
                ([, id]) => id === input.moduleId,
              )?.[0] as ModuleKind | undefined);
            if (!kind) throw new Error('module_missing');
            return {
              active: structuredClone(receipt.active),
              previous: structuredClone(this.envelope.document.previousActive ?? receipt.active),
              kind,
            };
          }
          const module = this.envelope.document.modules.find((item) => item.id === input.moduleId);
          if (!module) throw new Error('module_missing');
          assertSupportedHudModule(module);
          if (
            module.revision !== input.expectedRevision ||
            this.envelope.document.active.revision !== input.expectedActiveRevision
          )
            throw new Error('revision_conflict');
          return this.options.withApplyGuard((canCommit) =>
            this.options.withReferenceGuard(async () => {
              if (!this.envelope || !this.options.resolveModule)
                throw new Error('broadcast_config_unavailable');
              const previous = structuredClone(this.envelope.document.active);
              const prepared = await this.options.resolveModule(module);
              const active = structuredClone(previous);
              const kind = module.kind;
              const keep = new Set<string>();
              const add = (ref: ResourceRef) => keep.add(canonicalJson(ref));
              if (kind !== 'hud' && active.resolved.hud.renderer === 'web-hud') {
                add(active.resolved.hud.config.renderer.resource);
                for (const asset of Object.values(active.resolved.hud.config.panelAssets))
                  add(asset.resource);
              }
              if (kind !== 'program') {
                for (const scene of Object.values(active.resolved.program.scenes))
                  if (scene.kind === 'declarative') add(scene.resource);
                for (const asset of Object.values(active.resolved.program.assets))
                  add(asset.resource);
              }
              if (kind !== 'music' && active.resolved.music)
                for (const group of MUSIC_GROUPS)
                  for (const track of active.resolved.music.groups[group].tracks)
                    add(track.asset.resource);
              if (kind !== 'camera' && active.resolved.camera)
                for (const map of active.resolved.camera.maps)
                  if (map.openingSound) add(map.openingSound.asset.resource);
              const resources = new Map(
                previous.lock.resources
                  .filter((ref) => keep.has(canonicalJson(ref)))
                  .map((ref) => [canonicalJson(ref), ref]),
              );
              for (const ref of prepared.lock.resources) resources.set(canonicalJson(ref), ref);
              active.lock = {
                resources: [...resources.values()],
                tools: kind === 'camera' ? prepared.lock.tools : previous.lock.tools,
              };
              if (!sameEffectiveModule(kind, previous.resolved[kind], prepared.value))
                active.moduleRevisions[kind] = randomUUID();
              // The resolver checks that its result matches the selected module kind.
              (
                active.resolved as Record<
                  ModuleKind,
                  ActiveBroadcastSnapshot['resolved'][ModuleKind]
                >
              )[kind] = structuredClone(prepared.value);
              active.sourceModuleIds = { ...active.sourceModuleIds, [kind]: module.id };
              active.sourceModuleRevisions = {
                ...active.sourceModuleRevisions,
                [kind]: module.revision,
              };
              active.revision = randomUUID();
              active.adjusted = true;
              const next = structuredClone(this.envelope);
              next.document.previousActive = previous;
              next.document.active = active;
              next.receipts[input.requestId] = { fingerprint, active };
              await this.options.assertReferenceCommitAllowed(
                this.envelope.document,
                next.document,
              );
              await this.commit(next, canCommit);
              return { active: structuredClone(active), previous, kind };
            }),
          );
        });
        await this.options.onApplied?.(result.active, result.previous, result.kind);
        return result.active;
      } finally {
        this.applying = false;
      }
    });
  }
  /** Internal facade transaction; the legacy owner validates its edit before submitting it. */
  async updateFromLegacy<K extends ModuleKind>(input: {
    updateDraft(document: BroadcastConfigDocument): void;
    active?: {
      moduleId?: string | null | undefined;
      kind: K;
      value: ActiveBroadcastSnapshot['resolved'][K];
      lock: ActiveBroadcastSnapshot['lock'];
    };
  }): Promise<BroadcastConfigDocument> {
    return this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const next = structuredClone(this.envelope);
        const previous = structuredClone(next.document.active);
        const previousRecovery = canonicalJson(next.document.previousActive);
        input.updateDraft(next.document);
        for (const original of this.envelope.document.modules.filter((item) =>
          isBuiltinModuleId(item.id),
        )) {
          const current = next.document.modules.find((item) => item.id === original.id);
          if (!current || canonicalJson(current) !== canonicalJson(original))
            throw new Error('builtin_immutable');
        }
        for (const module of next.document.modules) {
          const old = this.envelope.document.modules.find((item) => item.id === module.id);
          if (old && old.kind !== module.kind) throw new Error('invalid_request');
          if (
            !old ||
            canonicalJson({ ...old, revision: '' }) !== canonicalJson({ ...module, revision: '' })
          )
            assertSupportedHudModule(module);
          module.revision =
            old &&
            canonicalJson({ ...old, revision: '' }) === canonicalJson({ ...module, revision: '' })
              ? old.revision
              : randomUUID();
        }
        for (const preset of next.document.presets) {
          const old = this.envelope.document.presets.find((item) => item.id === preset.id);
          preset.revision =
            old &&
            canonicalJson({ ...old, revision: '' }) === canonicalJson({ ...preset, revision: '' })
              ? old.revision
              : randomUUID();
        }

        if (
          canonicalJson(next.document.active) !== canonicalJson(previous) ||
          canonicalJson(next.document.previousActive) !== previousRecovery
        )
          throw new Error('active_mutation_forbidden');
        if (input.active) {
          const { kind, value, lock } = input.active;
          if (
            kind === 'hud' &&
            value &&
            'renderer' in value &&
            value.renderer === 'native' &&
            !isSupportedHudPauseVisual(value.overlays.pause.visual)
          )
            throw new Error('capability_unsupported');
          const active = structuredClone(previous);
          if (!sameEffectiveModule(kind, previous.resolved[kind], value))
            active.moduleRevisions[kind] = randomUUID();
          active.resolved[kind] = structuredClone(value);
          active.sourceModuleIds = {
            ...active.sourceModuleIds,
            [kind]: input.active.moduleId ?? null,
          };
          active.lock = structuredClone(lock);
          active.revision = randomUUID();
          active.adjusted = true;
          next.document.previousActive = previous;
          next.document.active = active;
          await this.options.verifyLegacyActive(
            parseBroadcastConfigDocument(next.document).active,
            kind,
          );
        }
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return this.snapshot;
      }),
    );
  }
  async preview(request: ApplyPresetRequest): Promise<ActiveBroadcastSnapshot> {
    return this.queue.run(async () =>
      preparePreset(this.snapshot, request, this.options.resolver, randomUUID),
    );
  }
  async apply(request: ApplyPresetRequest): Promise<ActiveBroadcastSnapshot> {
    return this.applyQueue.run(async () => {
      this.applying = true;
      try {
        const result = await this.queue.run(async () => {
          if (!this.envelope) throw new Error('broadcast_config_unavailable');
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              request.requestId,
            )
          )
            throw new Error('invalid_request');
          const fingerprint = canonicalJson(request);
          const receipt = this.envelope.receipts[request.requestId];
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new Error('request_conflict');
            return {
              active: structuredClone(receipt.active),
              previous: structuredClone(this.envelope.document.previousActive ?? receipt.active),
            };
          }
          return this.options.withApplyGuard((canCommit) =>
            this.options.withReferenceGuard(async () => {
              if (!this.envelope) throw new Error('broadcast_config_unavailable');
              const previous = this.envelope.document.active;
              const active = await preparePreset(
                this.snapshot,
                request,
                this.options.resolver,
                randomUUID,
              );
              const next = structuredClone(this.envelope);
              next.document.previousActive = structuredClone(previous);
              next.document.active = active;
              next.receipts[request.requestId] = { fingerprint, active };
              await this.options.assertReferenceCommitAllowed(
                this.envelope.document,
                next.document,
              );
              try {
                await this.commit(next, canCommit);
              } catch (error) {
                const disk = await this.read().catch(() => null);
                const committed = disk?.receipts[request.requestId];
                if (!disk || !committed || committed.fingerprint !== fingerprint) throw error;
                this.envelope = disk;
              }
              return { active: structuredClone(active), previous: structuredClone(previous) };
            }),
          );
        });
        // Owner queues may themselves be waiting for the coordinator; wait only after releasing it.
        await this.options.onApplied?.(result.active, result.previous);
        return result.active;
      } finally {
        this.applying = false;
      }
    });
  }
}
