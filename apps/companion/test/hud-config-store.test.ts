import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createHudPresetPack,
  getBuiltinLayouts,
  resolveHudPreset,
  getBuiltinPresets,
  getBuiltinThemes,
} from '@mizar/hud-config';
import { afterEach, describe, expect, it } from 'vitest';

import { HudConfigStore } from '../src/hud-config/store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rivalhub-hud-config-'));
  temporaryDirectories.push(directory);
  return join(directory, 'hud-config.json');
}

describe('HudConfigStore', () => {
  it('imports a complete pack atomically without activation and survives disk reload', async () => {
    const filePath = await temporaryConfigPath();
    const store = new HudConfigStore({ filePath });
    await store.load();
    const before = store.getState();
    const preset = getBuiltinPresets().find((item) => item.id === 'builtin:perfectworld-preset')!;
    preset.widgets['team-ct-rail'].settings.showBombPrediction = false;
    preset.widgets['team-t-rail'].settings.showBombPrediction = false;
    const pack = createHudPresetPack(
      preset,
      getBuiltinLayouts().find((item) => item.id === preset.layoutId)!,
      getBuiltinThemes().find((item) => item.id === preset.themeId)!,
    );
    const imported = await store.importPresetPack(pack, before.editorRevision);
    expect(imported.document.customPresets).toHaveLength(1);
    expect(imported.document.customLayouts).toHaveLength(1);
    expect(imported.document.customThemes).toHaveLength(1);
    expect(imported.etag).toBe(before.etag);
    expect(imported.resolved).toEqual(before.resolved);
    const copy = imported.document.customPresets[0]!;
    expect(copy.layoutId).toBe(imported.document.customLayouts[0]!.id);
    expect(copy.themeId).toBe(imported.document.customThemes[0]!.id);
    expect(imported.command.resourceId).toBe(copy.id);
    const loaded = new HudConfigStore({ filePath });
    await loaded.load();
    expect(loaded.getState().document).toEqual(imported.document);
    const activated = await loaded.activatePreset(copy.id, loaded.getState().editorRevision);
    expect(activated.resolved.widgets).toEqual(pack.preset.widgets);
    expect(activated.resolved.theme.semantic).toEqual(
      resolveHudPreset(pack.preset, pack.layout, pack.theme).theme.semantic,
    );
    const second = await loaded.importPresetPack(pack, activated.editorRevision);
    expect(second.document.customPresets[1]!.id).not.toBe(copy.id);
    expect(second.resolved).toEqual(activated.resolved);
    const disk = await readFile(filePath, 'utf8');
    await expect(loaded.importPresetPack(pack, before.editorRevision)).rejects.toThrow('另一页面');
    await expect(
      loaded.importPresetPack(
        { ...pack, theme: { ...pack.theme, recipe: 'unknown' } },
        second.editorRevision,
      ),
    ).rejects.toThrow('预设文件无效');
    expect(await readFile(filePath, 'utf8')).toBe(disk);
    expect(loaded.getState().document).toEqual(second.document);
  });

  it('does not overwrite a malformed file during startup recovery', async () => {
    const filePath = await temporaryConfigPath();
    const malformed = '{"schemaVersion":999,"customPresets":[]}\n';
    await writeFile(filePath, malformed, 'utf8');

    const diagnostics: { code: string; error: unknown }[] = [];
    const onDiagnostic = (code: string, error: unknown) => diagnostics.push({ code, error });
    const store = new HudConfigStore({ filePath, onDiagnostic });
    await store.load();

    expect(store.getState().resolved.preset.id).toBe('builtin:mizar-default-preset');
    await expect(readFile(filePath, 'utf8')).resolves.toBe(malformed);
    expect(diagnostics.at(-1)).toMatchObject({ code: 'hud_config_invalid' });
    expect(diagnostics.at(-1)?.error).toBeInstanceOf(Error);

    await writeFile(filePath, '{broken', 'utf8');
    await store.load();
    expect(diagnostics.at(-1)?.error).toBeInstanceOf(SyntaxError);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{broken');

    const unreadable = new HudConfigStore({ filePath: dirname(filePath), onDiagnostic });
    await unreadable.load();
    expect(diagnostics.at(-1)).toMatchObject({
      code: 'hud_config_read_failed',
      error: { code: 'EISDIR' },
    });
  });
  it('switches the legacy HUD writer only after coordinator initialization succeeds', async () => {
    const filePath = await temporaryConfigPath();
    const store = new HudConfigStore({ filePath });
    await store.load();
    await store.saveAs('theme', getBuiltinThemes()[0]!, store.getState().editorRevision);
    const oldBytes = await readFile(filePath, 'utf8');
    await expect(
      store.adoptPersistence({
        initialize: () => Promise.reject(new Error('unavailable')),
        commit: () => Promise.resolve(),
      }),
    ).rejects.toThrow('unavailable');
    expect(await readFile(filePath, 'utf8')).toBe(oldBytes);
    let persisted = store.getState().document;
    await store.adoptPersistence({
      initialize: (document) => {
        persisted = document;
        return Promise.resolve(document);
      },
      commit: (candidate) => {
        persisted = candidate;
        return Promise.resolve();
      },
    });
    const result = await store.saveAs(
      'theme',
      getBuiltinThemes()[0]!,
      store.getState().editorRevision,
    );
    expect(persisted).toEqual(result.document);
    expect(await readFile(filePath, 'utf8')).toBe(oldBytes);
  });
});
