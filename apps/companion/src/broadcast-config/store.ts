import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { canonicalJson } from '@mizar/hud-config';
import {
  boundModules,
  clonePreset,
  preparePreset,
  type ActiveBroadcastSnapshot,
  type ApplyPresetRequest,
  type BroadcastConfigDocument,
  type ClonePresetRequest,
  type BroadcastPreset,
  type ModuleRecord,
  type Revision,
  type PresetResolver,
} from '@mizar/broadcast-config';
import { replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';

interface Receipt {
  fingerprint: string;
  active: ActiveBroadcastSnapshot;
}
interface Envelope {
  version: 1;
  document: BroadcastConfigDocument;
  receipts: Record<string, Receipt>;
}

/** Parsing must use the registered domain codecs, including their resolved snapshot parsers. */
export interface BroadcastConfigStoreOptions {
  filePath: string;
  parseDocument(input: unknown): BroadcastConfigDocument;
  createInitial(): Promise<BroadcastConfigDocument>;
  resolver: PresetResolver;
  /** Holds the production and resource-reference guards through the commit. */
  withCommitGuard<T>(operation: () => Promise<T>): Promise<T>;
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
      Object.keys(value).some((key) => !['version', 'document', 'receipts'].includes(key))
    )
      throw new Error('broadcast_config_invalid');
    const document = this.options.parseDocument(value.document);
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
      const checked = this.options.parseDocument({ ...document, active: receipt.active });
      receipts[id] = { fingerprint: receipt.fingerprint, active: checked.active };
    }
    return { version: 1, document, receipts };
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
        const document = this.options.parseDocument(await this.options.createInitial());
        const initial: Envelope = { version: 1, document, receipts: {} };
        await replaceDurableJson(this.options.filePath, initial);
        this.envelope = await this.read();
      }
    });
  }
  get snapshot(): BroadcastConfigDocument {
    if (!this.envelope) throw new Error('broadcast_config_unavailable');
    return structuredClone(this.envelope.document);
  }
  private async commit(next: Envelope): Promise<void> {
    const checked = this.parseEnvelope(next);
    await replaceDurableJson(this.options.filePath, checked);
    this.envelope = checked;
  }
  async clone(request: ClonePresetRequest): Promise<{ presetId: string }> {
    return this.queue.run(() =>
      this.options.withCommitGuard(async () => {
        if (!this.envelope) throw new Error('broadcast_config_unavailable');
        const next = structuredClone(this.envelope);
        const copy = clonePreset(next.document, request, randomUUID);
        next.document.modules.push(...copy.modules);
        next.document.presets.push(copy.preset);
        await this.commit(next);
        return { presetId: copy.preset.id };
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
      this.options.withCommitGuard(async () => {
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
    return this.queue.run(() =>
      this.options.withCommitGuard(async () => {
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
        try {
          await this.commit(next);
        } catch (error) {
          // A rename may have succeeded even if a later persistence step failed.
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
  }
}
