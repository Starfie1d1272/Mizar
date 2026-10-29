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
type Catalog = z.infer<typeof catalogSchema>;

export class OrchestrationStore {
  preset = emptyOrchestrationPreset();
  activePresetId: string = randomUUID();
  presets: Catalog['presets'] = [];
  ready = false;
  automaticEnabled = false;
  revision = 0;
  private pendingWrites = 0;
  get saving() {
    return this.pendingWrites > 0;
  }
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
  ) {}
  async load() {
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
    try {
      const file = await safePath(this.directory, 'presets.json');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 9 * 1024 * 1024)
        throw new Error('camera_catalog_invalid');
      const catalog = catalogSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      this.activePresetId = catalog.activePresetId;
      this.preset = catalog.preset;
      this.presets = catalog.presets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
      await atomicJson(join(this.directory, 'presets.json'), this.catalog());
    }
    this.ready = true;
    this.diagnostic('camera_load', { result: 'success', preset: this.preset });
  }
  private catalog(): Catalog {
    return { activePresetId: this.activePresetId, preset: this.preset, presets: this.presets };
  }
  private writeCatalog(change: (catalog: Catalog) => Catalog, activate = false) {
    this.pendingWrites++;
    const result = this.queue.then(async () => {
      if (!this.ready) throw new Error('camera_storage_unavailable');
      const next = catalogSchema.parse(change(this.catalog()));
      await safePath(this.directory);
      await atomicJson(join(this.directory, 'presets.json'), next);
      this.activePresetId = next.activePresetId;
      this.preset = next.preset;
      this.presets = next.presets;
      if (activate) {
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
      this.pendingWrites--;
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
      await safePath(this.directory);
      await atomicJson(join(this.directory, 'presets.json'), next);
      this.activePresetId = id;
      this.preset = item.preset;
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
      await safePath(this.directory);
      await atomicJson(join(this.directory, 'settings.json'), { automaticEnabled });
      this.automaticEnabled = automaticEnabled;
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
