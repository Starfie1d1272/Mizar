// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BroadcastPresets } from '../src/resource-library/BroadcastPresets';

it('uses the inspected scheme and module revisions only on an explicit action', async () => {
  const view = {
    modules: [
      { id: 'h', kind: 'hud', name: 'HUD', revision: 'hr' },
      { id: 'p', kind: 'program', name: 'Pulse', revision: 'pr' },
      { id: 'm', kind: 'music', name: '导入音乐', revision: 'mr' },
    ],
    presets: [
      {
        id: 'preset',
        name: '直播',
        revision: 'revision',
        bindings: [
          { kind: 'hud', mode: 'use', moduleId: 'h' },
          { kind: 'program', mode: 'use', moduleId: 'p' },
          { kind: 'music', mode: 'off' },
          { kind: 'camera', mode: 'off' },
        ],
      },
    ],
    active: {
      revision: 'active',
      sourcePreset: { id: 'preset', revision: 'revision' },
      sourceModuleIds: { hud: 'h', program: 'p', music: null, camera: null },
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
    const fileInput = element.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['zip'], 'scheme.mizarpack');
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(element.textContent).toContain('播出方案已保存');
    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/resource-library/import-preset-pack',
      expect.objectContaining({ method: 'POST', body: file }),
    );
    const select = element.querySelector('select')!;
    await act(async () => {
      select.value = 'm';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const save = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === '保存音乐选择',
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
