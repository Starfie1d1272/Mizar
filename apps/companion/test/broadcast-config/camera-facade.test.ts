import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OrchestrationStore, type CameraConfigPersistence } from '../../src/orchestration/store.js';

it('delegates camera catalog and strategy without overwriting legacy files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'broadcast-camera-'));
  try {
    const store = new OrchestrationStore(directory);
    await store.load();
    const legacy = await readFile(join(directory, 'presets.json'), 'utf8');
    let saved = {
      catalog: {
        activePresetId: store.activePresetId,
        preset: structuredClone(store.preset),
        presets: structuredClone(store.presets),
      },
      automaticEnabled: store.automaticEnabled,
    };
    const owner: CameraConfigPersistence = {
      initialize: () => Promise.resolve(saved),
      read: () => Promise.resolve(saved),
      commit: (catalog, automaticEnabled) => {
        saved = { catalog: structuredClone(catalog), automaticEnabled };
        return Promise.resolve(saved);
      },
    };
    await store.adoptPersistence(owner);
    const id = await store.createPreset();
    await store.savePreset(id, { ...store.preset, name: 'Draft' });
    await store.saveAutomaticEnabled(true);
    expect(saved.catalog.activePresetId).not.toBe(id);
    expect(saved.automaticEnabled).toBe(true);
    expect(await readFile(join(directory, 'presets.json'), 'utf8')).toBe(legacy);
    const reopened = new OrchestrationStore(directory);
    await reopened.loadWithPersistence(owner);
    expect(reopened.activePresetId).toBe(saved.catalog.activePresetId);
    expect(reopened.presets.find((item) => item.id === id)?.preset.name).toBe('Draft');
    expect(reopened.automaticEnabled).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
