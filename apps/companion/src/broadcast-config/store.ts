import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { canonicalJson } from '@mizar/hud-config';
import { z } from 'zod';
import {
  boundModules,
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
} from '@mizar/broadcast-config';
import { durableJsonByteLength, replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';

interface Receipt {
  fingerprint: string;
  active: ActiveBroadcastSnapshot;
}
const importEntry = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const importMappingSchema = z.strictObject({
  source: resourceRefSchema,
  moduleEntries: z.record(importEntry, z.array(z.string().uuid()).min(1).max(128)),
  presetEntries: z.record(importEntry, z.string().uuid()),
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
}

/** Parsing must use the registered domain codecs, including their resolved snapshot parsers. */
export interface BroadcastConfigStoreOptions {
  filePath: string;
  createInitial(): Promise<BroadcastConfigDocument>;
  resolver: PresetResolver;
  /** Serializes changes to resource references with provider removal. */
  withReferenceGuard<T>(operation: () => Promise<T>): Promise<T>;
  /** Reject references being added to versions marked for deletion; missing external dependencies may remain drafts. */
  assertReferenceCommitAllowed(
    previous: BroadcastConfigDocument,
    next: BroadcastConfigDocument,
  ): Promise<void>;
  /** Verify all references and capabilities in an individually adjusted active snapshot. */
  verifyLegacyActive(active: ActiveBroadcastSnapshot): Promise<void>;
  /** Holds the production lifecycle and exposes a synchronous final readiness check. */
  withApplyGuard<T>(operation: (canCommit: () => boolean) => Promise<T>): Promise<T>;
  onApplied?(active: ActiveBroadcastSnapshot, previous: ActiveBroadcastSnapshot): void;
}

export class BroadcastConfigStore {
  private readonly queue = new SerialCommitQueue();
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
        (key) => !['version', 'document', 'receipts', 'imports'].includes(key),
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
    return { version: 1, document, receipts, imports };
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
        const initial: Envelope = { version: 1, document, receipts: {}, imports: [] };
        if (durableJsonByteLength(initial) > 16 * 1024 * 1024)
          throw new Error('broadcast_config_too_large', { cause: error });
        await replaceDurableJson(this.options.filePath, initial);
        this.envelope = await this.read();
      }
    });
  }
  get snapshot(): BroadcastConfigDocument {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    return structuredClone(this.envelope.document);
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
    return this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const next = structuredClone(this.envelope);
        const copy = clonePreset(next.document, request, randomUUID);
        next.document.modules.push(...copy.modules);
        next.document.presets.push(copy.preset);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return { presetId: copy.preset.id };
      }),
    );
  }
  /** Atomically installs drafts and their entry mapping without changing active configuration. */
  async importBatch(
    input: BroadcastImportBatch,
  ): Promise<{ mapping: BroadcastImportMapping; reused: boolean }> {
    return this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
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
          return { mapping: structuredClone(existing), reused: true };
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
          !sameIds(moduleIds, mappedModules) ||
          !sameIds(presetIds, mappedPresets)
        )
          throw new Error('invalid_import_mapping');
        const used = new Set<string>();
        for (const preset of input.presets)
          for (const binding of preset.bindings)
            if (binding.mode === 'use') {
              if (!moduleIds.includes(binding.moduleId) || used.has(binding.moduleId))
                throw new Error('invalid_import_mapping');
              used.add(binding.moduleId);
            }
        const next = structuredClone(this.envelope);
        next.document.modules.push(...structuredClone(input.modules));
        next.document.presets.push(...structuredClone(input.presets));
        next.imports.push(mapping);
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return { mapping: structuredClone(mapping), reused: false };
      }),
    );
  }
  /** Saves the preset and its edited modules in one draft-only commit. */
  async save(input: {
    preset: BroadcastPreset;
    expectedPresetRevision: Revision | null;
    modules: { value: ModuleRecord; expectedRevision: Revision | null }[];
  }): Promise<BroadcastConfigDocument> {
    return this.queue.run(() =>
      this.options.withReferenceGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const next = structuredClone(this.envelope);
        const oldPreset = next.document.presets.find((item) => item.id === input.preset.id);
        if ((oldPreset?.revision ?? null) !== input.expectedPresetRevision)
          throw new Error('revision_conflict');
        const seen = new Set<string>();
        for (const update of input.modules) {
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
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        return this.snapshot;
      }),
    );
  }
  /** Internal facade transaction; the legacy owner validates its edit before submitting it. */
  async updateFromLegacy<K extends ModuleKind>(input: {
    updateDraft(document: BroadcastConfigDocument): void;
    active?: {
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
        for (const module of next.document.modules) {
          const old = this.envelope.document.modules.find((item) => item.id === module.id);
          if (old && old.kind !== module.kind) throw new Error('invalid_request');
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
          const active = structuredClone(previous);
          if (!sameEffectiveModule(kind, previous.resolved[kind], value))
            active.moduleRevisions[kind] = randomUUID();
          active.resolved[kind] = structuredClone(value);
          active.lock = structuredClone(lock);
          active.revision = randomUUID();
          active.adjusted = true;
          next.document.previousActive = previous;
          next.document.active = active;
          await this.options.verifyLegacyActive(active);
        }
        await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
        await this.commit(next);
        if (input.active) {
          try {
            this.options.onApplied?.(structuredClone(next.document.active), previous);
          } catch {
            /* Persistence remains authoritative. */
          }
        }
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
    return this.queue.run(async () => {
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
        return structuredClone(receipt.active);
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
          await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
          try {
            await this.commit(next, canCommit);
          } catch (error) {
            const disk = await this.read().catch(() => null);
            const committed = disk?.receipts[request.requestId];
            if (!disk || !committed || committed.fingerprint !== fingerprint) throw error;
            this.envelope = disk;
          }
          try {
            this.options.onApplied?.(structuredClone(active), structuredClone(previous));
          } catch {
            /* Persistence remains authoritative. */
          }
          return structuredClone(active);
        }),
      );
    });
  }
}
