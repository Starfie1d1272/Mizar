import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emptyOrchestrationPreset,
  orchestrationPresetSchema,
  type OrchestrationPreset,
} from '@mizar/protocol/orchestration';
import { atomicJson, ensureDirectory, safePath } from '../resource-store/files.js';

export class OrchestrationStore {
  preset = emptyOrchestrationPreset();
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
      const file = await safePath(this.directory, 'preset.json');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
        throw new Error('camera_preset_invalid');
      this.preset = orchestrationPresetSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
    this.ready = true;
    this.diagnostic('camera_load', { result: 'success', preset: this.preset });
  }
  save(input: unknown) {
    const preset = orchestrationPresetSchema.parse(input);
    this.pendingWrites++;
    this.diagnostic('camera_configure', { result: 'begin', preset });
    const result = this.queue.then(async () => {
      if (!this.ready) throw new Error('camera_storage_unavailable');
      await safePath(this.directory);
      await atomicJson(join(this.directory, 'preset.json'), preset);
      this.preset = preset;
      this.revision++;
      this.diagnostic('camera_configure', { result: 'success', preset, revision: this.revision });
    });
    this.queue = result.catch((error: unknown) => {
      this.diagnostic('camera_configure', { result: 'failure', error });
    });
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
