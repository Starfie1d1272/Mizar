import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultHudConfigDocument,
  getBuiltinLayout,
  getBuiltinPreset,
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
