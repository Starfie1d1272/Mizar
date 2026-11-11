import { describe, expect, it } from 'vitest';
import {
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinResolvedPreset,
  getBuiltinTheme,
} from '@mizar/hud-config';
import {
  clonePreset,
  preparePreset,
  type BroadcastConfigDocument,
  type ModuleRecord,
} from '../src/index.js';

function fixture(): BroadcastConfigDocument {
  const modules = [
    {
      id: 'h',
      kind: 'hud',
      revision: 'h1',
      schemaVersion: 1,
      name: 'HUD',
      origin: null,
      value: {
        renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
        preset: getBuiltinPreset(),
        layout: getBuiltinLayout(),
        theme: getBuiltinTheme(),
        overlays: {
          pause: { enabled: true, visual: 'legacy' },
          chat: { enabled: true, placement: 'auto' },
        },
        accent: { source: 'fixed', value: getBuiltinTheme().brandColor },
      },
    },
    {
      id: 'p',
      kind: 'program',
      revision: 'p1',
      schemaVersion: 1,
      name: 'Program',
      origin: null,
      value: {},
    },
    {
      id: 'm',
      kind: 'music',
      revision: 'm1',
      schemaVersion: 1,
      name: 'Music',
      origin: null,
      value: {},
    },
  ] as ModuleRecord[];
  return {
    schemaVersion: 1,
    modules,
    presets: [
      {
        schemaVersion: 1,
        id: 'preset',
        revision: 'r1',
        name: 'Live',
        origin: null,
        opaqueModules: [],
        bindings: [
          { kind: 'hud', mode: 'use', moduleId: 'h' },
          { kind: 'program', mode: 'use', moduleId: 'p' },
          { kind: 'music', mode: 'use', moduleId: 'm' },
          { kind: 'camera', mode: 'off' },
        ],
      },
    ],
    active: {
      schemaVersion: 1,
      revision: 'a1',
      sourcePreset: null,
      adjusted: false,
      moduleRevisions: { hud: 'ah', program: 'ap', music: 'am', camera: 'ac' },
      resolved: {
        hud: {
          renderer: 'native',
          config: getBuiltinResolvedPreset(),
          overlays: {
            pause: { enabled: true, visual: 'legacy' },
            chat: { enabled: true, placement: 'auto' },
          },
          accent: { source: 'fixed', value: getBuiltinTheme().brandColor },
        },
        program: {},
        music: {},
        camera: null,
      },
      lock: { resources: [], tools: [] },
    },
    previousActive: null,
  } as unknown as BroadcastConfigDocument;
}
const expected = { hud: 'h1', program: 'p1', music: 'm1' };

describe('broadcast preset', () => {
  it('copies editable objects and rewrites HUD references without touching the source', () => {
    const document = fixture();
    let id = 0;
    const copy = clonePreset(
      document,
      {
        sourceId: 'preset',
        expectedRevision: 'r1',
        expectedModuleRevisions: expected,
        name: 'Copy',
      },
      () => `new-${++id}`,
    );
    const hud = copy.modules.find((module) => module.kind === 'hud')!;
    if (hud.kind !== 'hud' || !('preset' in hud.value)) throw new Error('unexpected HUD');
    expect(hud.value.preset.layoutId).toBe(hud.value.layout.id);
    expect(hud.value.preset.themeId).toBe(hud.value.theme.id);
    expect(hud.value.preset.id).not.toBe(getBuiltinPreset().id);
    hud.value.preset.name = 'Edited';
    expect((document.modules[0]!.value as { preset: { name?: string } }).preset.name).toBe(
      getBuiltinPreset().name,
    );
    expect(() =>
      clonePreset(
        document,
        {
          sourceId: 'preset',
          expectedRevision: 'r1',
          expectedModuleRevisions: { ...expected, music: 'stale' },
          name: 'Copy',
        },
        () => 'id',
      ),
    ).toThrow('revision_conflict');
  });
  it('ignores copied native HUD editor IDs and names but detects visual changes', async () => {
    const document = fixture();
    const previous = document.active.resolved.hud;
    if (previous.renderer !== 'native') throw new Error('unexpected HUD');
    const copied = structuredClone(previous);
    copied.config = {
      ...copied.config,
      preset: {
        ...copied.config.preset,
        id: 'copy',
        name: 'Copy',
        layoutId: 'layout-copy',
        themeId: 'theme-copy',
      },
      layout: { ...copied.config.layout, id: 'layout-copy', name: 'Copy' },
      theme: { ...copied.config.theme, id: 'theme-copy', name: 'Copy' },
    };
    const request = {
      presetId: 'preset',
      expectedRevision: 'r1',
      expectedModuleRevisions: expected,
      expectedActiveRevision: 'a1',
      requestId: 'request',
    };
    const candidate = await preparePreset(
      document,
      request,
      {
        resolve: () =>
          Promise.resolve({
            resolved: { ...document.active.resolved, hud: copied },
            lock: { resources: [], tools: [] },
          }),
      },
      () => 'new',
    );
    expect(candidate.moduleRevisions.hud).toBe('ah');
    copied.overlays.pause.enabled = false;
    const changed = await preparePreset(
      document,
      request,
      {
        resolve: () =>
          Promise.resolve({
            resolved: { ...document.active.resolved, hud: copied },
            lock: { resources: [], tools: [] },
          }),
      },
      () => 'new',
    );
    expect(changed.moduleRevisions.hud).toBe('new');
  });
});
