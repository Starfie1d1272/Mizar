// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BroadcastPresets } from '../src/resource-library/BroadcastPresets';

it('uses the inspected scheme and module revisions only on an explicit action', async () => {
  const view = {
    modules: [
      { id: 'h', kind: 'hud', name: 'HUD', revision: 'hr' },
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'program',
        schemaVersion: 1,
        name: 'Pulse',
        revision: 'pr',
        origin: null,
        value: {
          scenes: Object.fromEntries(
            ['waiting', 'matchup', 'bp', 'halftime', 'map_result', 'intermap', 'match_result'].map(
              (id) => [id, { kind: 'builtin', id: 'pulse', apiVersion: 1 }],
            ),
          ),
          tokens: {},
          assets: {},
        },
      },
      { id: 'm', kind: 'music', name: '导入音乐', revision: 'mr' },
    ],
    presets: [
      {
        id: 'preset',
        name: '直播',
        revision: 'revision',
        bindings: [
          { kind: 'hud', mode: 'use', moduleId: 'h' },
          { kind: 'program', mode: 'use', moduleId: '00000000-0000-4000-8000-000000000002' },
          { kind: 'music', mode: 'off' },
          { kind: 'camera', mode: 'off' },
        ],
      },
    ],
    active: {
      revision: 'active',
      sourcePreset: { id: 'preset', revision: 'revision' },
      sourceModuleIds: {
        hud: 'h',
        program: '00000000-0000-4000-8000-000000000002',
        music: null,
        camera: null,
      },
      sourceModuleRevisions: { hud: 'old', program: 'pr', music: null, camera: null },
      adjusted: false,
    },
  };
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    void options;
    return path === '/local/v1/broadcast-presets'
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(view) })
      : Promise.resolve({ ok: true, json: () => Promise.resolve({ reused: false }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<BroadcastPresets query="" />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain('已修改，尚未使用');
    expect(element.textContent).not.toContain('当前使用');
    const select = [
      ...element.querySelectorAll<HTMLSelectElement>('.resource-library__preset select'),
    ][2]!;
    await act(async () => {
      select.value = 'm';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const save = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === '保存方案',
    )!;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    const saveArgs = fetchMock.mock.calls.find(
      ([path]) => path === '/operator/broadcast-presets/save',
    );
    const saved = JSON.parse(saveArgs![1]!.body as string) as {
      expectedPresetRevision: string;
      modules: unknown[];
      preset: { bindings: unknown[] };
    };
    expect(saved.expectedPresetRevision).toBe('revision');
    expect(saved.modules).toEqual([]);
    expect(saved.preset.bindings).toContainEqual({ kind: 'music', mode: 'use', moduleId: 'm' });
    expect(
      fetchMock.mock.calls.some(([path]) => path === '/operator/broadcast-presets/apply'),
    ).toBe(false);
    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === '使用方案',
    )!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    const args = fetchMock.mock.calls.find(
      ([path]) => path === '/operator/broadcast-presets/apply',
    );
    expect(args?.[1]?.body).toEqual(expect.any(String));
    expect(JSON.parse(args![1]!.body as string) as unknown).toMatchObject({
      presetId: 'preset',
      expectedRevision: 'revision',
      expectedModuleRevisions: { hud: 'hr', program: 'pr' },
      expectedActiveRevision: 'active',
    });
    expect(element.textContent).toContain('已使用「直播」');
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});

it('exports selected schemes together without using them', async () => {
  const bindings = [
    { kind: 'hud', mode: 'use', moduleId: 'h' },
    { kind: 'program', mode: 'use', moduleId: '00000000-0000-4000-8000-000000000002' },
    { kind: 'music', mode: 'off' },
    { kind: 'camera', mode: 'off' },
  ];
  const view = {
    modules: [
      { id: 'h', kind: 'hud', name: 'HUD', revision: 'hr' },
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'program',
        schemaVersion: 1,
        name: 'Pulse',
        revision: 'pr',
        origin: null,
        value: {
          scenes: Object.fromEntries(
            ['waiting', 'matchup', 'bp', 'halftime', 'map_result', 'intermap', 'match_result'].map(
              (id) => [id, { kind: 'builtin', id: 'pulse', apiVersion: 1 }],
            ),
          ),
          tokens: {},
          assets: {},
        },
      },
    ],
    presets: [
      { id: 'one', name: '标准', revision: 'one-r', bindings },
      { id: 'two', name: '简洁', revision: 'two-r', bindings },
    ],
    active: { revision: 'active', sourcePreset: null, adjusted: false },
  };
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    void options;
    return path === '/local/v1/broadcast-presets'
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(view) })
      : Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['zip'])) });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:example', revokeObjectURL: () => {} });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<BroadcastPresets query="" />);
      await Promise.resolve();
    });
    act(() =>
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '选择多个方案')!
        .click(),
    );
    const boxes = [...element.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes).toHaveLength(2);
    act(() => {
      boxes[0]!.click();
      boxes[1]!.click();
    });
    const exportButton = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === '分享所选（2）',
    )!;
    await act(async () => {
      exportButton.click();
      await Promise.resolve();
    });
    const args = fetchMock.mock.calls.find(
      ([path]) => path === '/operator/resource-library/export-pack',
    );
    const body = JSON.parse(args![1]!.body as string) as {
      presets: {
        presetId: string;
        expectedRevision: string;
        expectedModuleRevisions: Record<string, string>;
      }[];
    };
    expect(body.presets).toEqual([
      {
        presetId: 'one',
        expectedRevision: 'one-r',
        expectedModuleRevisions: { hud: 'hr', program: 'pr' },
      },
      {
        presetId: 'two',
        expectedRevision: 'two-r',
        expectedModuleRevisions: { hud: 'hr', program: 'pr' },
      },
    ]);
    expect(
      fetchMock.mock.calls.some(([path]) => path === '/operator/broadcast-presets/apply'),
    ).toBe(false);
    expect(click).toHaveBeenCalledOnce();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  } finally {
    act(() => root.unmount());
    element.remove();
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('creates a saved scheme without activating it', async () => {
  const view = {
    modules: [
      { id: 'h', kind: 'hud', name: 'HUD', revision: 'hr' },
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'program',
        schemaVersion: 1,
        name: 'Pulse',
        revision: 'pr',
        origin: null,
        value: {
          scenes: Object.fromEntries(
            ['waiting', 'matchup', 'bp', 'halftime', 'map_result', 'intermap', 'match_result'].map(
              (id) => [id, { kind: 'builtin', id: 'pulse', apiVersion: 1 }],
            ),
          ),
          tokens: {},
          assets: {},
        },
      },
    ],
    presets: [],
    active: { revision: 'active', sourcePreset: null, adjusted: false },
  };
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    void options;
    return Promise.resolve({ ok: true, json: async () => view });
  });
  vi.stubGlobal('fetch', fetchMock);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<BroadcastPresets query="" />);
      await Promise.resolve();
    });
    const input = element.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, '新方案');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const selects = element.querySelectorAll('select');
    act(() => {
      selects[0]!.value = 'h';
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }));
      selects[1]!.value = '00000000-0000-4000-8000-000000000002';
      selects[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '保存新方案')!
        .click();
      await Promise.resolve();
    });
    const call = fetchMock.mock.calls.find(
      ([path]) => path === '/operator/broadcast-presets/save',
    )!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({
      expectedPresetRevision: null,
      modules: [],
      preset: {
        name: '新方案',
        bindings: [
          { kind: 'hud', mode: 'use', moduleId: 'h' },
          { kind: 'program', mode: 'use', moduleId: '00000000-0000-4000-8000-000000000002' },
          { kind: 'music', mode: 'off' },
          { kind: 'camera', mode: 'off' },
        ],
      },
    });
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/apply'))).toBe(false);
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
