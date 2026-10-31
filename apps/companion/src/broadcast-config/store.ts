import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import {
  canonicalJson,
  getBuiltinLayouts,
  getBuiltinPresets,
  getBuiltinThemes,
  type HudConfigDocument,
} from '@mizar/hud-config';
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
  type PortableMusicConfigV1,
  type HudModule,
} from '@mizar/broadcast-config';
import { durableJsonByteLength, replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import {
  addMissingBuiltinModules,
  BUILTIN_MODULE_IDS,
  createBuiltinModules,
  isBuiltinModuleId,
} from './builtin-modules.js';
import { broadcastResourceReferences } from './reference-queue.js';
import { cameraCatalogSchema } from '../orchestration/store.js';
import { hudDocumentFromBroadcast } from './hud-facade.js';

interface Receipt {
  fingerprint: string;
  activeRevision: Revision;
  failed?: ModuleKind[];
}
const receiptFingerprint = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
type ConsumerKind = 'hud' | 'music' | 'camera' | 'program';
type ConsumerApplied = {
  revision: Revision;
  moduleRevision: Revision;
  sourceModuleId: string | null;
  sourceModuleRevision: Revision | null;
  value: ActiveBroadcastSnapshot['resolved'][ConsumerKind];
  lock: ActiveBroadcastSnapshot['lock'];
};
type ConsumerState = {
  applied: ConsumerApplied | null;
  error: string | null;
  desired?: string;
};
function compactConsumer(kind: ConsumerKind, active: ActiveBroadcastSnapshot): ConsumerApplied {
  const resources = new Map<string, ResourceRef>();
  const add = (ref: ResourceRef) => resources.set(canonicalJson(ref), ref);
  if (kind === 'hud' && active.resolved.hud.renderer === 'web-hud') {
    add(active.resolved.hud.config.renderer.resource);
    for (const asset of Object.values(active.resolved.hud.config.panelAssets)) add(asset.resource);
  } else if (kind === 'program') {
    for (const scene of Object.values(active.resolved.program.scenes))
      if (scene.kind === 'declarative') add(scene.resource);
    for (const asset of Object.values(active.resolved.program.assets)) add(asset.resource);
  } else if (kind === 'music' && active.resolved.music) {
    for (const group of MUSIC_GROUPS)
      for (const track of active.resolved.music.groups[group].tracks) add(track.asset.resource);
  } else if (kind === 'camera' && active.resolved.camera) {
    for (const map of active.resolved.camera.maps)
      if (map.openingSound) add(map.openingSound.asset.resource);
  }
  return {
    revision: active.revision,
    moduleRevision: active.moduleRevisions[kind],
    sourceModuleId: active.sourceModuleIds?.[kind] ?? null,
    sourceModuleRevision: active.sourceModuleRevisions?.[kind] ?? null,
    value: structuredClone(active.resolved[kind]),
    lock: {
      resources: [...resources.values()],
      tools: kind === 'camera' ? structuredClone(active.lock.tools) : [],
    },
  };
}
function expandConsumer(
  kind: ConsumerKind,
  applied: ConsumerApplied,
  active: ActiveBroadcastSnapshot,
): ActiveBroadcastSnapshot {
  const snapshot = structuredClone(active);
  snapshot.revision = applied.revision;
  snapshot.moduleRevisions[kind] = applied.moduleRevision;
  snapshot.sourceModuleIds = { ...snapshot.sourceModuleIds, [kind]: applied.sourceModuleId };
  snapshot.sourceModuleRevisions = {
    ...snapshot.sourceModuleRevisions,
    [kind]: applied.sourceModuleRevision,
  };
  (snapshot.resolved as Record<ConsumerKind, ConsumerApplied['value']>)[kind] = structuredClone(
    applied.value,
  );
  snapshot.lock = structuredClone(applied.lock);
  return snapshot;
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
  pendingReceipt?: { requestId: string; receipt: Receipt };
  receiptFormat?: 2;
  consumerFormat?: 2;
  imports: BroadcastImportMapping[];
  consumers?: Partial<Record<ConsumerKind, ConsumerState>>;
  builtinsNormalized?: boolean | undefined;
  pendingLegacyCamera?: PendingLegacyCamera | undefined;
  restoredLegacyCamera?:
    Array<{ legacyId: string; moduleId: string; activeSnapshot: boolean }> | undefined;
}
function receiptFor(envelope: Envelope, requestId: string): Receipt | undefined {
  return envelope.pendingReceipt?.requestId === requestId
    ? envelope.pendingReceipt.receipt
    : envelope.receipts[requestId];
}
function setPendingReceipt(envelope: Envelope, requestId: string, receipt: Receipt): void {
  if (envelope.pendingReceipt && envelope.pendingReceipt.requestId !== requestId)
    envelope.receipts[envelope.pendingReceipt.requestId] = envelope.pendingReceipt.receipt;
  delete envelope.receipts[requestId];
  envelope.pendingReceipt = { requestId, receipt };
}
function archivePendingReceipt(envelope: Envelope): void {
  if (!envelope.pendingReceipt) return;
  envelope.receipts[envelope.pendingReceipt.requestId] = envelope.pendingReceipt.receipt;
  delete envelope.pendingReceipt;
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
    failed?: ModuleKind[],
  ): void | Promise<void>;
  resolveModule?(module: ModuleRecord): Promise<{
    value: ActiveBroadcastSnapshot['resolved'][ModuleKind];
    lock: ActiveBroadcastSnapshot['lock'];
  }>;
  canApplyModule?(
    kind: ModuleKind,
    value: ActiveBroadcastSnapshot['resolved'][ModuleKind],
  ): boolean;
  canChangeCamera?(): boolean;
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
  canChangeCamera(): boolean {
    return this.options.canChangeCamera?.() ?? true;
  }

  private parseEnvelope(input: unknown): Envelope {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('broadcast_config_invalid');
    const value = input as Record<string, unknown>;
    if (
      (value.receiptFormat !== undefined && value.receiptFormat !== 2) ||
      (value.consumerFormat !== undefined && value.consumerFormat !== 2)
    )
      throw new Error('broadcast_config_invalid');
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
            'pendingReceipt',
            'receiptFormat',
            'imports',
            'consumers',
            'consumerFormat',
            'builtinsNormalized',
            'pendingLegacyCamera',
            'restoredLegacyCamera',
          ].includes(key),
      )
    )
      throw new Error('broadcast_config_invalid');
    const document = parseBroadcastConfigDocument(value.document);
    const consumers: Partial<Record<ConsumerKind, ConsumerState>> = {};
    if (value.consumers !== undefined) {
      const entries = z.record(z.string(), z.unknown()).parse(value.consumers);
      for (const [key, raw] of Object.entries(entries)) {
        if (!['hud', 'music', 'camera', 'program'].includes(key))
          throw new Error('broadcast_config_invalid');
        const entry = z
          .strictObject({
            applied: z.unknown(),
            error: z.string().nullable(),
            desired: z.string().optional(),
          })
          .parse(raw);
        const kind = key as ConsumerKind;
        let applied: ConsumerApplied | null = null;
        if (entry.applied !== null) {
          const raw = z.record(z.string(), z.unknown()).parse(entry.applied);
          if (raw.schemaVersion === 1) {
            applied = compactConsumer(
              kind,
              parseBroadcastConfigDocument({ ...document, active: raw }).active,
            );
          } else {
            const value = z
              .strictObject({
                revision: z.string().min(1).max(200),
                moduleRevision: z.string().min(1).max(200),
                sourceModuleId: z.string().uuid().nullable(),
                sourceModuleRevision: z.string().min(1).max(200).nullable(),
                value: z.unknown(),
                lock: z.unknown(),
              })
              .parse(raw);
            const expanded = expandConsumer(kind, value as ConsumerApplied, document.active);
            applied = compactConsumer(
              kind,
              parseBroadcastConfigDocument({ ...document, active: expanded }).active,
            );
          }
        }
        consumers[kind] = {
          applied,
          error: entry.error,
          ...(entry.desired ? { desired: entry.desired } : {}),
        };
      }
    }
    const receipts: Record<string, Receipt> = Object.create(null) as Record<string, Receipt>;
    const parseReceipt = (raw: unknown): Receipt => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('broadcast_config_invalid');
      const receipt = raw as Record<string, unknown>;
      if (
        typeof receipt.fingerprint !== 'string' ||
        (receipt.fingerprint.startsWith('sha256:') &&
          !/^sha256:[0-9a-f]{64}$/.test(receipt.fingerprint)) ||
        (receipt.active !== undefined && receipt.activeRevision !== undefined) ||
        Object.keys(receipt).some(
          (key) => !['fingerprint', 'active', 'activeRevision', 'failed'].includes(key),
        )
      )
        throw new Error('broadcast_config_invalid');
      const activeRevision =
        receipt.active === undefined
          ? z.string().min(1).max(200).parse(receipt.activeRevision)
          : parseBroadcastConfigDocument({ ...document, active: receipt.active }).active.revision;
      const failed = z
        .array(z.enum(['hud', 'program', 'music', 'camera']))
        .optional()
        .parse(receipt.failed);
      return {
        fingerprint: receipt.fingerprint.startsWith('sha256:')
          ? receipt.fingerprint
          : receiptFingerprint(receipt.fingerprint),
        activeRevision,
        ...(failed?.length ? { failed } : {}),
      };
    };
    for (const [id, raw] of Object.entries(value.receipts)) receipts[id] = parseReceipt(raw);
    let pendingReceipt: Envelope['pendingReceipt'];
    if (value.pendingReceipt !== undefined) {
      const pending = z
        .strictObject({ requestId: z.string().uuid(), receipt: z.unknown() })
        .parse(value.pendingReceipt);
      if (Object.hasOwn(receipts, pending.requestId)) throw new Error('broadcast_config_invalid');
      pendingReceipt = { requestId: pending.requestId, receipt: parseReceipt(pending.receipt) };
    } else if (value.receiptFormat !== 2) {
      const current = Object.entries(receipts).find(
        ([, receipt]) => receipt.activeRevision === document.active.revision,
      );
      if (current) {
        pendingReceipt = { requestId: current[0], receipt: current[1] };
        delete receipts[current[0]];
      }
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
      ...(pendingReceipt ? { pendingReceipt } : {}),
      ...(value.receiptFormat === 2 ? { receiptFormat: 2 as const } : {}),
      ...(value.consumerFormat === 2 ? { consumerFormat: 2 as const } : {}),
      imports,
      consumers,
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
          receiptFormat: 2,
          consumerFormat: 2,
          imports: [],
          ...(pendingLegacyCamera ? { pendingLegacyCamera } : {}),
        };
        if (durableJsonByteLength(initial) > 16 * 1024 * 1024)
          throw new Error('broadcast_config_too_large', { cause: error });
        await replaceDurableJson(this.options.filePath, initial);
        this.envelope = await this.read();
      }
      const next = structuredClone(this.envelope);
      if (next.receiptFormat !== 2 || next.consumerFormat !== 2) {
        next.receiptFormat = 2;
        next.consumerFormat = 2;
        await this.commit(next);
      }
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
    return this.envelope !== null && receiptFor(this.envelope, requestId) !== undefined;
  }
  receiptFailures(requestId: string): ModuleKind[] {
    return this.envelope ? [...(receiptFor(this.envelope, requestId)?.failed ?? [])] : [];
  }
  get snapshot(): BroadcastConfigDocument {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    return structuredClone(this.envelope.document);
  }
  get consumerStatus() {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    const active = this.envelope.document.active;
    return Object.fromEntries(
      (['hud', 'program', 'music', 'camera'] as const).map((kind) => {
        const state = this.envelope!.consumers?.[kind];
        return [
          kind,
          {
            desired: state?.desired ?? active.moduleRevisions[kind],
            applied: state?.applied?.moduleRevision ?? null,
            error: state?.error ?? null,
          },
        ];
      }),
    );
  }
  appliedSnapshot(kind: ConsumerKind): ActiveBroadcastSnapshot | null {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    const applied = this.envelope.consumers?.[kind]?.applied;
    return applied ? expandConsumer(kind, applied, this.envelope.document.active) : null;
  }
  get appliedDisplay(): ActiveBroadcastSnapshot {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    const active = structuredClone(this.envelope.document.active);
    for (const kind of ['hud', 'program'] as const) {
      const state = this.envelope.consumers?.[kind];
      const applied = state?.applied;
      if (applied) {
        active.resolved[kind] = structuredClone(applied.value) as never;
        active.moduleRevisions[kind] = applied.moduleRevision;
      } else if (state?.error && kind === 'program') {
        const fallback = createBuiltinModules().find(
          (module) => module.id === BUILTIN_MODULE_IDS.pulse,
        );
        if (!fallback || fallback.kind !== 'program')
          throw new Error('broadcast_config_unavailable');
        active.resolved.program = fallback.value;
      } else if (state?.error && kind === 'hud') throw new Error('broadcast_config_unavailable');
    }
    return active;
  }
  async recordConsumer(
    kind: ConsumerKind,
    active: ActiveBroadcastSnapshot,
    error: string | null,
    reset = false,
  ) {
    await this.queue.run(async () => {
      if (!this.envelope) throw new Error('broadcast_config_unavailable');
      if (this.envelope.document.active.moduleRevisions[kind] !== active.moduleRevisions[kind])
        throw new Error('revision_conflict');
      const next = structuredClone(this.envelope);
      next.consumers ??= {};
      const previous = next.consumers[kind];
      next.consumers[kind] = {
        applied: error
          ? reset
            ? null
            : (previous?.applied ?? null)
          : compactConsumer(kind, active),
        error,
        ...(error && previous?.desired ? { desired: previous.desired } : {}),
      };
      await this.commit(next);
    });
  }
  /** Include resources exposed by durable apply receipts as well as the current document. */
  referencedResources(): ResourceRef[] {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    const refs = new Map(
      broadcastResourceReferences(this.envelope.document).map((ref) => [canonicalJson(ref), ref]),
    );
    for (const state of Object.values(this.envelope.consumers ?? {}))
      for (const ref of state.applied?.lock.resources ?? []) refs.set(canonicalJson(ref), ref);
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
    return copy;
  }
  async deleteModule(
    id: string,
    expectedRevision: Revision,
    replacement?: { moduleId: string | null; expectedPresetRevisions: Record<string, Revision> },
  ): Promise<void> {
    await this.queue.run(() =>
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
          const fingerprint = receiptFingerprint(canonicalJson({ action: 'module', ...input }));
          const receipt = receiptFor(this.envelope, input.requestId);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new Error('request_conflict');
            if (receipt.activeRevision !== this.envelope.document.active.revision)
              throw new Error('revision_conflict');
            const active = this.envelope.document.active;
            const module = this.envelope.document.modules.find(
              (item) => item.id === input.moduleId,
            );
            const kind =
              module?.kind ??
              (Object.entries(active.sourceModuleIds ?? {}).find(
                ([, id]) => id === input.moduleId,
              )?.[0] as ModuleKind | undefined);
            if (!kind) throw new Error('module_missing');
            return {
              active: structuredClone(active),
              previous: structuredClone(this.envelope.document.previousActive ?? active),
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
              if (
                this.options.canApplyModule &&
                !this.options.canApplyModule(module.kind, prepared.value)
              )
                throw new Error('camera_busy');
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
              setPendingReceipt(next, input.requestId, {
                fingerprint,
                activeRevision: active.revision,
              });
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
  /** Commit a music edit through the broadcast configuration owner. */
  async applyMusicEdit(input: {
    expectedActiveRevision: Revision;
    value: PortableMusicConfigV1;
    lock: ActiveBroadcastSnapshot['lock'];
  }): Promise<BroadcastConfigDocument> {
    const document = this.snapshot;
    const active = document.active;
    if (active.revision !== input.expectedActiveRevision) throw new Error('revision_conflict');
    const captured = document.modules.find(
      (item) => item.id === active.sourceModuleIds?.music && item.kind === 'music',
    );
    const usages = captured
      ? document.presets.filter((preset) =>
          preset.bindings.some(
            (binding) => binding.mode === 'use' && binding.moduleId === captured.id,
          ),
        ).length
      : 0;
    const reusable =
      captured?.kind === 'music' &&
      !isBuiltinModuleId(captured.id) &&
      usages <= 1 &&
      canonicalJson(captured.value) === canonicalJson(active.resolved.music);
    const moduleId = reusable ? captured.id : randomUUID();
    return this.commitEdit({
      updateDraft(next) {
        if (next.active.revision !== input.expectedActiveRevision)
          throw new Error('revision_conflict');
        const existing = next.modules.find((item) => item.id === moduleId);
        if (reusable) {
          if (!existing || existing.kind !== 'music' || existing.revision !== captured.revision)
            throw new Error('revision_conflict');
          existing.value = input.value;
        } else {
          if (existing) throw new Error('revision_conflict');
          next.modules.push({
            id: moduleId,
            kind: 'music',
            schemaVersion: 1,
            revision: randomUUID(),
            name: '音乐',
            value: input.value,
            origin: null,
          });
        }
      },
      active: { kind: 'music', value: input.value, lock: input.lock, moduleId },
    });
  }
  /** Commit camera drafts and an optional active selection as one store transaction. */
  async applyCameraEdit(input: {
    expectedActiveRevision: Revision;
    drafts: Array<{ id: string; value: CameraModuleV2; expectedRevision: Revision | null }>;
    active?: {
      value: CameraModuleV2 | null;
      lock: ActiveBroadcastSnapshot['lock'];
      moduleId: string | null;
    };
  }): Promise<BroadcastConfigDocument> {
    return this.commitEdit({
      updateDraft(document) {
        if (document.active.revision !== input.expectedActiveRevision)
          throw new Error('revision_conflict');
        for (const draft of input.drafts) {
          const module = document.modules.find((item) => item.id === draft.id);
          if (
            (module?.revision ?? null) !== draft.expectedRevision ||
            (module && module.kind !== 'camera')
          )
            throw new Error('revision_conflict');
          if (module?.kind === 'camera') {
            module.value = draft.value;
            module.name = draft.value.name;
          } else {
            document.modules.push({
              id: draft.id,
              kind: 'camera',
              schemaVersion: 2,
              revision: draft.id,
              name: draft.value.name,
              value: draft.value,
              origin: null,
            });
          }
        }
      },
      ...(input.active ? { active: { kind: 'camera' as const, ...input.active } } : {}),
    });
  }
  async applyHudEdit(input: {
    candidate: HudConfigDocument;
    previous: HudConfigDocument;
    activeChanged: boolean;
    oldHud: Extract<ActiveBroadcastSnapshot['resolved']['hud'], { renderer: 'native' }>;
    nextHud: Extract<ActiveBroadcastSnapshot['resolved']['hud'], { renderer: 'native' }>;
    lock: ActiveBroadcastSnapshot['lock'];
    moduleId?: string | undefined;
  }): Promise<BroadcastConfigDocument> {
    const { candidate, previous, activeChanged, oldHud, nextHud, lock } = input;
    return this.commitEdit({
      updateDraft(document) {
        const currentDocument = hudDocumentFromBroadcast(document);
        if (
          canonicalJson({ ...currentDocument, activePreset: previous.activePreset }) !==
            canonicalJson(previous) ||
          (activeChanged &&
            canonicalJson(currentDocument.activePreset) !== canonicalJson(previous.activePreset))
        )
          throw new Error('revision_conflict');
        const layouts = [...getBuiltinLayouts(), ...candidate.customLayouts];
        const themes = [...getBuiltinThemes(), ...candidate.customThemes];
        for (const preset of [...getBuiltinPresets(), ...candidate.customPresets]) {
          const layout = layouts.find((item) => item.id === preset.layoutId);
          const theme = themes.find((item) => item.id === preset.themeId);
          if (!layout || !theme) throw new Error('hud_resource_missing');
          const old = document.modules.find(
            (item) =>
              item.kind === 'hud' && 'preset' in item.value && item.value.preset.id === preset.id,
          ) as ModuleRecord<'hud'> | undefined;
          if (old && isBuiltinModuleId(old.id)) continue;
          const template = old?.value ?? oldHud;
          if (!('preset' in template) && !('overlays' in template))
            throw new Error('hud_renderer_unsupported');
          const value: HudModule = {
            renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
            preset: structuredClone(preset),
            layout: structuredClone(layout),
            theme: structuredClone(theme),
            overlays: structuredClone(template.overlays),
            accent: structuredClone(template.accent),
          };
          if (old) {
            old.name = preset.name;
            old.value = value;
          } else
            document.modules.push({
              id: randomUUID(),
              revision: randomUUID(),
              kind: 'hud',
              schemaVersion: 1,
              name: preset.name,
              value,
              origin: null,
            });
        }
        document.unboundHudResources = {
          layouts: candidate.customLayouts.filter(
            (item) => !candidate.customPresets.some((preset) => preset.layoutId === item.id),
          ),
          themes: candidate.customThemes.filter(
            (item) => !candidate.customPresets.some((preset) => preset.themeId === item.id),
          ),
        };
      },
      ...(activeChanged
        ? { active: { kind: 'hud' as const, moduleId: input.moduleId, value: nextHud, lock } }
        : {}),
    });
  }
  /** Apply a validated consumer edit within the shared configuration transaction. */
  private async commitEdit<K extends ModuleKind>(input: {
    updateDraft(document: BroadcastConfigDocument): void;
    active?: {
      moduleId?: string | null | undefined;
      kind: K;
      value: ActiveBroadcastSnapshot['resolved'][K];
      lock: ActiveBroadcastSnapshot['lock'];
    };
  }): Promise<BroadcastConfigDocument> {
    const execute = (canCommit: () => boolean) =>
      this.queue.run(() =>
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
              kind === 'camera' &&
              this.options.canApplyModule &&
              !this.options.canApplyModule(kind, value)
            )
              throw new Error('camera_busy');
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
            archivePendingReceipt(next);
            await this.options.verifyLegacyActive(
              parseBroadcastConfigDocument(next.document).active,
              kind,
            );
          }
          await this.options.assertReferenceCommitAllowed(this.envelope.document, next.document);
          await this.commit(
            next,
            () =>
              canCommit() &&
              (!input.active ||
                input.active.kind !== 'camera' ||
                !this.options.canApplyModule ||
                this.options.canApplyModule(input.active.kind, input.active.value)),
          );
          return this.snapshot;
        }),
      );
    return input.active?.kind === 'camera'
      ? this.options.withApplyGuard(execute)
      : execute(() => true);
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
          const fingerprint = receiptFingerprint(canonicalJson(request));
          const receipt = receiptFor(this.envelope, request.requestId);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new Error('request_conflict');
            if (receipt.activeRevision !== this.envelope.document.active.revision)
              throw new Error('revision_conflict');
            if (!receipt.failed?.length)
              return {
                active: structuredClone(this.envelope.document.active),
                previous: structuredClone(
                  this.envelope.document.previousActive ?? this.envelope.document.active,
                ),
                failed: [] as ModuleKind[],
              };
          }
          return this.options.withApplyGuard((canCommit) =>
            this.options.withReferenceGuard(async () => {
              if (!this.envelope) throw new Error('broadcast_config_unavailable');
              const previous = this.envelope.document.active;
              const failed: ModuleKind[] = [];
              const failedDesired: Partial<Record<ModuleKind, string>> = {};
              const failedReasons: Partial<Record<ModuleKind, string>> = {};
              const partialResolver: PresetResolver = {
                resolve: async (modules) => {
                  if (!this.options.resolveModule) return this.options.resolver.resolve(modules);
                  const resolved = structuredClone(previous.resolved);
                  const resources = new Map(
                    previous.lock.resources.map((ref) => [canonicalJson(ref), ref]),
                  );
                  let cameraTools = previous.lock.tools;
                  for (const kind of ['hud', 'program', 'music', 'camera'] as const) {
                    const module = modules.get(kind);
                    if (!module) {
                      if (kind === 'hud' || kind === 'program') throw new Error('module_missing');
                      if (this.options.canApplyModule && !this.options.canApplyModule(kind, null)) {
                        failed.push(kind);
                        failedDesired[kind] = 'off';
                        failedReasons[kind] = 'camera_busy';
                        continue;
                      }
                      resolved[kind] = null;
                      if (kind === 'camera') cameraTools = [];
                      continue;
                    }
                    try {
                      const result = await this.options.resolveModule(module);
                      if (
                        this.options.canApplyModule &&
                        !this.options.canApplyModule(kind, result.value)
                      )
                        throw new Error('camera_busy');
                      (
                        resolved as Record<
                          ModuleKind,
                          ActiveBroadcastSnapshot['resolved'][ModuleKind]
                        >
                      )[kind] = result.value;
                      for (const ref of result.lock.resources)
                        resources.set(canonicalJson(ref), ref);
                      if (kind === 'camera') cameraTools = result.lock.tools;
                    } catch (error) {
                      failed.push(kind);
                      failedDesired[kind] = module.revision;
                      failedReasons[kind] =
                        error instanceof Error && error.message === 'camera_busy'
                          ? 'camera_busy'
                          : 'dependency_unavailable';
                    }
                  }
                  const used = new Set<string>();
                  const add = (ref: ResourceRef) => used.add(canonicalJson(ref));
                  if (resolved.hud.renderer === 'web-hud') {
                    add(resolved.hud.config.renderer.resource);
                    for (const asset of Object.values(resolved.hud.config.panelAssets))
                      add(asset.resource);
                  }
                  for (const scene of Object.values(resolved.program.scenes))
                    if (scene.kind === 'declarative') add(scene.resource);
                  for (const asset of Object.values(resolved.program.assets)) add(asset.resource);
                  if (resolved.music)
                    for (const group of MUSIC_GROUPS)
                      for (const track of resolved.music.groups[group].tracks)
                        add(track.asset.resource);
                  if (resolved.camera)
                    for (const map of resolved.camera.maps)
                      if (map.openingSound) add(map.openingSound.asset.resource);
                  return {
                    resolved,
                    lock: {
                      resources: [...resources.entries()]
                        .filter(([key]) => used.has(key))
                        .map(([, ref]) => ref),
                      tools: cameraTools,
                    },
                  };
                },
              };
              const document = this.snapshot;
              const preset = document.presets.find((item) => item.id === request.presetId);
              if (!preset) throw new Error('preset_missing');
              if (!receipt && previous.revision !== request.expectedActiveRevision)
                throw new Error('revision_conflict');
              const modules = boundModules(preset, document.modules);
              if (preset.revision !== request.expectedRevision)
                throw new Error('revision_conflict');
              for (const [kind, module] of modules)
                if (module && request.expectedModuleRevisions[kind] !== module.revision)
                  throw new Error('revision_conflict');
              const prepared = await partialResolver.resolve(modules);
              const moduleRevisions = { ...previous.moduleRevisions };
              for (const kind of ['hud', 'program', 'music', 'camera'] as const)
                if (!sameEffectiveModule(kind, previous.resolved[kind], prepared.resolved[kind]))
                  moduleRevisions[kind] = randomUUID();
              const active: ActiveBroadcastSnapshot = {
                schemaVersion: 1,
                revision: randomUUID(),
                sourcePreset: { id: preset.id, revision: preset.revision },
                adjusted: false,
                moduleRevisions,
                sourceModuleIds: Object.fromEntries(
                  [...modules].map(([kind, module]) => [kind, module?.id ?? null]),
                ),
                sourceModuleRevisions: Object.fromEntries(
                  [...modules].map(([kind, module]) => [kind, module?.revision ?? null]),
                ),
                resolved: prepared.resolved,
                lock: prepared.lock,
              };
              if (failed.length) active.adjusted = true;
              for (const kind of failed) {
                active.sourceModuleIds![kind] = previous.sourceModuleIds?.[kind] ?? null;
                active.sourceModuleRevisions![kind] =
                  previous.sourceModuleRevisions?.[kind] ?? null;
              }
              const next = structuredClone(this.envelope);
              next.document.previousActive = structuredClone(previous);
              next.document.active = active;
              setPendingReceipt(next, request.requestId, {
                fingerprint,
                activeRevision: active.revision,
                ...(failed.length ? { failed } : {}),
              });
              next.consumers ??= {};
              for (const kind of failed) {
                next.consumers[kind] = {
                  applied: next.consumers[kind]?.applied ?? null,
                  error: failedReasons[kind] ?? 'dependency_unavailable',
                  ...(failedDesired[kind] ? { desired: failedDesired[kind] } : {}),
                };
              }
              await this.options.assertReferenceCommitAllowed(
                this.envelope.document,
                next.document,
              );
              try {
                await this.commit(next, canCommit);
              } catch (error) {
                const disk = await this.read().catch(() => null);
                const committed = disk && receiptFor(disk, request.requestId);
                if (
                  !disk ||
                  !committed ||
                  committed.fingerprint !== fingerprint ||
                  committed.activeRevision !== active.revision
                )
                  throw error;
                this.envelope = disk;
              }
              return {
                active: structuredClone(active),
                previous: structuredClone(previous),
                failed,
              };
            }),
          );
        });
        // Owner queues may themselves be waiting for the coordinator; wait only after releasing it.
        await this.options.onApplied?.(result.active, result.previous, undefined, result.failed);
        return result.active;
      } finally {
        this.applying = false;
      }
    });
  }
}
