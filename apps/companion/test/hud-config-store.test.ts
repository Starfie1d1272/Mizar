import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultHudConfigDocument,
  createHudPresetPack,
  getBuiltinLayouts,
  resolveHudPreset,
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinPresets,
  getBuiltinThemes,
  getBuiltinTheme,
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

  it('leaves no partial imported resources when persistence fails', async () => {
    const path = await temporaryConfigPath();
    const store = new HudConfigStore({ filePath: join(path, 'unavailable', 'hud.json') });
    const before = store.getState();
    const pack = createHudPresetPack(getBuiltinPreset(), getBuiltinLayout(), getBuiltinTheme());
    // An existing file cannot serve as the parent directory for a transaction.
    await writeFile(path, 'occupied');
    await expect(store.importPresetPack(pack, before.editorRevision)).rejects.toThrow('持久化失败');
    expect(store.getState().document).toEqual(before.document);
    expect(store.getState().resolved).toEqual(before.resolved);
  });

  it.each(['ewc', 'iem', 'perfectworld'])(
    'persists %s and preserves its recipe when copied',
    async (style) => {
      const filePath = await temporaryConfigPath();
      const store = new HudConfigStore({ filePath });
      await store.load();
      const preset = getBuiltinPresets().find((item) => item.id === `builtin:${style}-preset`)!;
      const theme = getBuiltinThemes().find((item) => item.id === preset.themeId)!;
      const active = await store.activatePreset(preset.id);
      expect(active.resolved.widgets['team-ct-rail'].variant).toBe(style);
      expect(active.resolved.theme.recipe).toBe(style);
      const loaded = new HudConfigStore({ filePath });
      await loaded.load();
      expect(loaded.getState().resolved).toEqual(active.resolved);
      expect(loaded.getState().document.customThemes).toHaveLength(0);
      const copiedTheme = await loaded.saveAs('theme', { ...theme, name: `${style} theme copy` });
      const themeId = copiedTheme.document.customThemes[0]!.id;
      const copied = await loaded.saveAs('preset', { ...preset, name: `${style} copy`, themeId });
      expect(copied.resolved).toEqual(active.resolved);
      const customId = copied.document.customPresets[0]!.id;
      const customActive = await loaded.activatePreset(customId);
      expect(customActive.resolved.theme.semantic).toEqual(active.resolved.theme.semantic);
      expect(customActive.resolved.widgets).toEqual(active.resolved.widgets);
      const restarted = new HudConfigStore({ filePath });
      await restarted.load();
      expect(restarted.getState().resolved).toEqual(customActive.resolved);
      await restarted.activatePreset('builtin:mizar-default-preset');
      expect(restarted.getState().resolved.widgets['team-ct-rail'].variant).toBe('default');
    },
  );

  it('uses the built-in default when the file is absent and preserves activation separately from saves', async () => {
    const filePath = await temporaryConfigPath();
    const store = new HudConfigStore({ filePath });
    await store.load();
    const initial = store.getState();

    expect(initial.document.activePreset).toEqual({
      kind: 'builtin',
      sourceId: 'builtin:mizar-default-preset',
    });
    expect(initial.resolved.preset.id).toBe('builtin:mizar-default-preset');

    const layoutState = await store.saveAs('layout', {
      ...getBuiltinLayout(),
      id: 'draft-layout',
      name: '现场布局',
    });
    const layoutId = layoutState.document.customLayouts[0]!.id;
    const themeState = await store.saveAs('theme', {
      ...getBuiltinTheme(),
      id: 'draft-theme',
      name: '校园紫',
      brandColor: '#aa66ff',
    });
    const themeId = themeState.document.customThemes[0]!.id;
    const presetState = await store.saveAs('preset', {
      ...getBuiltinPreset(),
      id: 'draft-preset',
      name: '校园赛决赛',
      layoutId,
      themeId,
    });
    const presetId = presetState.document.customPresets[0]!.id;

    const active = await store.activatePreset(presetId);
    expect(active.document.activePreset.kind).toBe('custom');
    expect(active.resolved.theme.brandColor).toBe('#aa66ff');
    const activeEtag = active.etag;

    const updatedTheme = {
      ...active.document.customThemes[0]!,
      brandColor: '#00ffaa',
    };
    const saved = await store.saveResource('theme', updatedTheme);
    expect(saved.etag).toBe(activeEtag);
    expect(saved.activationStale).toBe(true);

    const reactivated = await store.activatePreset(presetId);
    expect(reactivated.etag).not.toBe(activeEtag);
    expect(reactivated.resolved.theme.brandColor).toBe('#00ffaa');
    expect(reactivated.activationStale).toBe(false);

    const reloaded = new HudConfigStore({ filePath });
    await reloaded.load();
    expect(reloaded.getState().resolved.theme.brandColor).toBe('#00ffaa');
  });

  it('persists the Shanghai prediction switch without replacing its layout', async () => {
    const filePath = await temporaryConfigPath();
    const store = new HudConfigStore({ filePath });
    const preset = getBuiltinPresets().find((p) => p.id === 'builtin:perfectworld-preset')!;
    preset.widgets['team-ct-rail'].settings.showBombPrediction = false;
    preset.widgets['team-t-rail'].settings.showBombPrediction = false;
    const saved = await store.saveAs('preset', { ...preset, name: '预测关闭' });
    await store.activatePreset(saved.command.resourceId!);
    const restarted = new HudConfigStore({ filePath });
    await restarted.load();
    const resolved = restarted.getState().resolved;
    expect(resolved.layout.id).toBe('builtin:perfectworld-layout');
    expect(resolved.widgets['team-ct-rail'].settings.showBombPrediction).toBe(false);
    expect(resolved.widgets['team-t-rail'].settings.showBombPrediction).toBe(false);
  });

  it('does not overwrite a malformed file during startup recovery', async () => {
    const filePath = await temporaryConfigPath();
    const malformed = '{"schemaVersion":999,"customPresets":[]}\n';
    await writeFile(filePath, malformed, 'utf8');

    const store = new HudConfigStore({ filePath });
    await store.load();

    expect(store.getState().resolved.preset.id).toBe('builtin:mizar-default-preset');
    await expect(readFile(filePath, 'utf8')).resolves.toBe(malformed);
  });

  it('keeps the last valid document when a later reload is malformed', async () => {
    const filePath = await temporaryConfigPath();
    const valid = {
      ...createDefaultHudConfigDocument(),
      customThemes: [{ ...getBuiltinTheme(), id: 'theme-valid', name: '有效外观' }],
    };
    await writeFile(filePath, `${JSON.stringify(valid)}\n`, 'utf8');
    const store = new HudConfigStore({ filePath });
    await store.load();
    expect(store.getState().document.customThemes[0]?.name).toBe('有效外观');

    const malformed = '{"schemaVersion":999}\n';
    await writeFile(filePath, malformed, 'utf8');
    await store.load();
    expect(store.getState().document.customThemes[0]?.name).toBe('有效外观');
    await expect(readFile(filePath, 'utf8')).resolves.toBe(malformed);
  });

  it('serializes concurrent save-as operations from the latest document', async () => {
    const store = new HudConfigStore();

    const [first, second] = await Promise.all([
      store.saveAs('theme', {
        ...getBuiltinTheme(),
        id: 'draft-theme-a',
        name: '外观 A',
      }),
      store.saveAs('theme', {
        ...getBuiltinTheme(),
        id: 'draft-theme-b',
        name: '外观 B',
      }),
    ]);

    expect(first.command.resourceId).toEqual(expect.any(String));
    expect(second.command.resourceId).toEqual(expect.any(String));
    expect(first.command.resourceId).not.toBe(second.command.resourceId);
    expect(store.getState().document.customThemes.map((theme) => theme.name)).toEqual([
      '外观 A',
      '外观 B',
    ]);
  });
});
