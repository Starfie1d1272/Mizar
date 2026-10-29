import { describe, expect, it } from 'vitest';
import {
  boundModules,
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
        preset: { id: 'p', layoutId: 'l', themeId: 't' },
        layout: { id: 'l' },
        theme: { id: 't' },
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
      resolved: { hud: { renderer: 'native', config: {} }, program: {}, music: {}, camera: null },
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
    expect(hud.value.preset.id).not.toBe('p');
    hud.value.preset.name = 'Edited';
    expect(
      (document.modules[0]!.value as { preset: { name?: string } }).preset.name,
    ).toBeUndefined();
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
  it('rejects incomplete bindings and changes only the revision of an effectively changed module', async () => {
    const document = fixture();
    expect(() =>
      boundModules(
        { ...document.presets[0]!, bindings: document.presets[0]!.bindings.slice(0, 3) },
        document.modules,
      ),
    ).toThrow('incomplete_preset');
    const resolved = {
      ...document.active.resolved,
      hud: { renderer: 'native', config: { changed: true } },
    } as unknown as typeof document.active.resolved;
    let id = 0;
    const next = await preparePreset(
      document,
      {
        presetId: 'preset',
        expectedRevision: 'r1',
        expectedModuleRevisions: expected,
        expectedActiveRevision: 'a1',
        requestId: 'request',
      },
      { resolve: async () => ({ resolved, lock: { resources: [], tools: [] } }) },
      () => `revision-${++id}`,
    );
    expect(next.moduleRevisions).toEqual({
      hud: 'revision-1',
      program: 'ap',
      music: 'am',
      camera: 'ac',
    });
    expect(document.active.revision).toBe('a1');
  });
  it('does not revise camera when only the acquisition release changes', async () => {
    const document = fixture();
    const source = {
      sourceName: 'default',
      treeSha256: 'a'.repeat(64),
      converterVersion: 1,
      acquisition: {
        kind: 'upstream',
        release: {
          repository: 'Co1Swet/MulNX_CS2',
          releaseId: 1,
          assetId: 1,
          tag: 'v1',
          archiveSha256: 'b'.repeat(64),
        },
      },
    };
    const camera = {
      format: 'mizar.camera-config',
      version: 2,
      name: 'Camera',
      automaticEnabled: true,
      maps: [{ map: 'de_example', source }],
    } as unknown as NonNullable<typeof document.active.resolved.camera>;
    document.active.resolved.camera = camera;
    const changed = structuredClone(camera);
    const acquisition = changed.maps[0]!.source.acquisition;
    if (acquisition.kind !== 'upstream') throw new Error('unexpected source');
    acquisition.release.releaseId = 2;
    const next = await preparePreset(
      document,
      {
        presetId: 'preset',
        expectedRevision: 'r1',
        expectedModuleRevisions: expected,
        expectedActiveRevision: 'a1',
        requestId: 'request',
      },
      {
        resolve: async () => ({
          resolved: { ...document.active.resolved, camera: changed },
          lock: { resources: [], tools: [] },
        }),
      },
      () => 'new',
    );
    expect(next.moduleRevisions.camera).toBe('ac');
  });
});
