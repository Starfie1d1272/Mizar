import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emptyOrchestrationPreset,
  orchestrationPresetSchema,
  type OrchestrationPreset,
} from '@mizar/protocol/orchestration';
import { atomicJson, ensureDirectory, safePath } from '../resource-store/files.js';

const catalogBytes = 9 * 1024 * 1024;
const catalogSchema = z
  .strictObject({
    activePresetId: z.uuid(),
    preset: orchestrationPresetSchema,
    presets: z
      .array(z.strictObject({ id: z.uuid(), preset: orchestrationPresetSchema }))
      .min(1)
      .max(32),
  })
  .refine(
    (catalog) =>
      new Set(catalog.presets.map((item) => item.id)).size === catalog.presets.length &&
      catalog.presets.some((item) => item.id === catalog.activePresetId),
  );
export type CameraCatalog = z.infer<typeof catalogSchema>;
type Catalog = CameraCatalog;
interface CameraPersistenceState {
  catalog: CameraCatalog;
  automaticEnabled: boolean;
  revision?: string | undefined;
}
export interface CameraConfigPersistence {
  initialize(catalog: CameraCatalog, automaticEnabled: boolean): Promise<CameraPersistenceState>;
  read(): Promise<CameraPersistenceState>;
  commit(
    catalog: CameraCatalog,
    automaticEnabled: boolean,
    previous: CameraCatalog,
    previousAutomaticEnabled: boolean,
  ): Promise<CameraPersistenceState>;
}

export class OrchestrationStore {
  preset = emptyOrchestrationPreset();
  activePresetId: string = randomUUID();
  presets: Catalog['presets'] = [];
  ready = false;
  automaticEnabled = false;
  revision = 0;
  private pendingWrites = 0;
  get hasPersistence() {
    return this.persistence !== undefined;
  }
  get saving() {
    return this.pendingWrites > 0;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private persistence: CameraConfigPersistence | undefined;
  private persistedRevision: string | undefined;
  constructor(
    readonly directory: string,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
  ) {}
  async load() {
    if (this.persistence) {
      const result = this.queue.then(async () => {
        if (!this.persistence) throw new Error('camera_storage_unavailable');
        this.usePersisted(await this.persistence.read());
        this.ready = true;
      });
      this.queue = result.catch(() => undefined);
      return result;
    }
    this.ready = false;
    await ensureDirectory(this.directory);
    try {
      const file = await safePath(this.directory, 'settings.json');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
        throw new Error('camera_settings_invalid');
      const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (
        !settings ||
        typeof settings !== 'object' ||
        Array.isArray(settings) ||
        Object.keys(settings).length !== 1 ||
        typeof (settings as { automaticEnabled?: unknown }).automaticEnabled !== 'boolean'
      )
        throw new Error('camera_settings_invalid');
      this.automaticEnabled = (settings as { automaticEnabled: boolean }).automaticEnabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let migrate = false;
    try {
      const file = await safePath(this.directory, 'presets.json');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > catalogBytes)
        throw new Error('camera_catalog_invalid');
      const catalog = catalogSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      this.activePresetId = catalog.activePresetId;
      this.preset = catalog.preset;
      this.presets = catalog.presets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      migrate = true;
    }
    if (migrate) {
      try {
        const file = await safePath(this.directory, 'preset.json');
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
          throw new Error('camera_preset_invalid');
        this.preset = orchestrationPresetSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.presets = [{ id: this.activePresetId, preset: this.preset }];
      await atomicJson(join(this.directory, 'presets.json'), this.catalog(), catalogBytes);
    }
    this.ready = true;
    this.diagnostic('camera_load', { result: 'success', preset: this.preset });
  }
  private usePersisted(value: CameraPersistenceState): void {
    const catalog = catalogSchema.parse(value.catalog);
    if (typeof value.automaticEnabled !== 'boolean') throw new Error('camera_settings_invalid');
    this.activePresetId = catalog.activePresetId;
    this.preset = catalog.preset;
    this.presets = catalog.presets;
    this.automaticEnabled = value.automaticEnabled;
    this.persistedRevision = value.revision;
  }
  async loadWithPersistence(persistence: CameraConfigPersistence): Promise<void> {
    if (this.ready || this.persistence) throw new Error('camera_storage_unavailable');
    await ensureDirectory(this.directory);
    const state = await persistence.read();
    this.usePersisted(state);
    this.persistence = persistence;
    this.ready = true;
  }
  async adoptPersistence(persistence: CameraConfigPersistence): Promise<void> {
    const result = this.queue.then(async () => {
      if (!this.ready || this.persistence) throw new Error('camera_storage_unavailable');
      const value = await persistence.initialize(
        structuredClone(this.catalog()),
        this.automaticEnabled,
      );
      this.usePersisted(value);
      this.persistence = persistence;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async synchronizeFromPersistence(): Promise<void> {
    const result = this.queue.then(async () => {
      if (!this.ready || !this.persistence) throw new Error('camera_storage_unavailable');
      const before = JSON.stringify({ ...this.preset, name: '' });
      const automatic = this.automaticEnabled;
      const revision = this.persistedRevision;
      this.usePersisted(await this.persistence.read());
      if (
        this.persistedRevision !== undefined
          ? revision !== this.persistedRevision
          : before !== JSON.stringify({ ...this.preset, name: '' }) ||
            automatic !== this.automaticEnabled
      )
        this.revision++;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async persistCatalog(
    next: CameraCatalog,
    automaticEnabled: boolean,
  ): Promise<CameraPersistenceState> {
    if (this.persistence)
      return this.persistence.commit(next, automaticEnabled, this.catalog(), this.automaticEnabled);
    await safePath(this.directory);
    await atomicJson(join(this.directory, 'presets.json'), next, catalogBytes);
    return { catalog: next, automaticEnabled };
  }
  private catalog(): Catalog {
    return { activePresetId: this.activePresetId, preset: this.preset, presets: this.presets };
  }
  private writeCatalog(change: (catalog: Catalog) => Catalog, activate = false) {
    if (activate) this.pendingWrites++;
    const result = this.queue.then(async () => {
      if (!this.ready) throw new Error('camera_storage_unavailable');
      const next = catalogSchema.parse(change(this.catalog()));
      const previousRevision = this.persistedRevision;
      const previousPreset = JSON.stringify({ ...this.preset, name: '' });
      this.usePersisted(await this.persistCatalog(next, this.automaticEnabled));
      if (activate) {
        if (
          !this.persistence ||
          (this.persistedRevision !== undefined
            ? previousRevision !== this.persistedRevision
            : previousPreset !== JSON.stringify({ ...this.preset, name: '' }))
        )
          this.revision++;
        this.diagnostic('camera_configure', {
          result: 'success',
          preset: this.preset,
          revision: this.revision,
        });
      }
    });
    this.queue = result.catch((error: unknown) => {
      this.diagnostic('camera_configure', { result: 'failure', error });
    });
    return result.finally(() => {
      if (activate) this.pendingWrites--;
    });
  }
  save(input: unknown) {
    const preset = orchestrationPresetSchema.parse(input);
    return this.writeCatalog(
      (catalog) => ({
        ...catalog,
        preset,
        presets: catalog.presets.map((item) =>
          item.id === catalog.activePresetId ? { ...item, preset } : item,
        ),
      }),
      true,
    );
  }
  async createPreset(sourceId?: string) {
    const id = randomUUID();
    await this.writeCatalog((catalog) => {
      const source = sourceId ? catalog.presets.find((item) => item.id === sourceId) : undefined;
      if (sourceId && !source) throw new Error('camera_preset_missing');
      return {
        ...catalog,
        presets: [...catalog.presets, { id, preset: source?.preset ?? emptyOrchestrationPreset() }],
      };
    });
    return id;
  }
  savePreset(id: string, input: unknown) {
    const preset = orchestrationPresetSchema.parse(input);
    return this.writeCatalog((catalog) => {
      if (!catalog.presets.some((item) => item.id === id)) throw new Error('camera_preset_missing');
      return {
        ...catalog,
        presets: catalog.presets.map((item) => (item.id === id ? { id, preset } : item)),
      };
    });
  }
  activatePreset(id: string, validate: (preset: OrchestrationPreset) => Promise<void>) {
    return this.writeCatalogAsyncActivate(id, validate);
  }
  private writeCatalogAsyncActivate(
    id: string,
    validate: (preset: OrchestrationPreset) => Promise<void>,
  ) {
    this.pendingWrites++;
    const result = this.queue.then(async () => {
      if (!this.ready) throw new Error('camera_storage_unavailable');
      const item = this.presets.find((entry) => entry.id === id);
      if (!item) throw new Error('camera_preset_missing');
      await validate(item.preset);
      const next = { ...this.catalog(), activePresetId: id, preset: item.preset };
      const previousRevision = this.persistedRevision;
      const previousPreset = JSON.stringify({ ...this.preset, name: '' });
      this.usePersisted(await this.persistCatalog(next, this.automaticEnabled));
      if (
        !this.persistence ||
        (this.persistedRevision !== undefined
          ? previousRevision !== this.persistedRevision
          : previousPreset !== JSON.stringify({ ...this.preset, name: '' }))
      )
        this.revision++;
      this.diagnostic('camera_configure', {
        result: 'success',
        preset: this.preset,
        revision: this.revision,
      });
    });
    this.queue = result.catch((error: unknown) =>
      this.diagnostic('camera_configure', { result: 'failure', error }),
    );
    return result.finally(() => {
      this.pendingWrites--;
    });
  }
  saveAutomaticEnabled(automaticEnabled: boolean) {
    this.pendingWrites++;
    const result = this.queue.then(async () => {
      if (!this.ready) throw new Error('camera_storage_unavailable');
      if (this.persistence) {
        const previousRevision = this.persistedRevision;
        const previousAutomatic = this.automaticEnabled;
        this.usePersisted(await this.persistCatalog(this.catalog(), automaticEnabled));
        if (
          this.persistedRevision !== undefined
            ? previousRevision !== this.persistedRevision
            : previousAutomatic !== this.automaticEnabled
        )
          this.revision++;
      } else {
        await safePath(this.directory);
        await atomicJson(join(this.directory, 'settings.json'), { automaticEnabled });
        this.automaticEnabled = automaticEnabled;
      }
    });
    this.queue = result.catch(() => {});
    return result.finally(() => {
      this.pendingWrites--;
    });
  }
  map(name: string | null): OrchestrationPreset['maps'][number] | undefined {
    return this.preset.maps.find((m) => m.map === name);
  }
}
