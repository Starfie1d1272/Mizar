// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ResourceModules } from '../src/resource-library/ResourceModules';

it('uses and exports the selected module with its revision without applying while inspecting', async () => {
  const module = {
    id: 'music-one',
    name: '音乐',
    kind: 'music',
    revision: 'm1',
    origin: null,
    value: { groups: {} },
  };
  const snapshot = {
    modules: [module],
    presets: [],
    active: { revision: 'a1', sourceModuleIds: {}, sourceModuleRevisions: {} },
  };
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    void options;
    if (path === '/local/v1/broadcast-presets')
      return Promise.resolve({ ok: true, json: async () => snapshot });
    if (path === '/local/v1/broadcast-modules')
      return Promise.resolve({
        ok: true,
        json: async () => ({ modules: [{ module, builtin: false }] }),
      });
    return Promise.resolve({
      ok: true,
      json: async () => ({}),
      blob: async () => new Blob(['zip']),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:example', revokeObjectURL: () => {} });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<ResourceModules query="" category="all" onImported={() => {}} />);
      await Promise.resolve();
    });
    act(() =>
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '查看详情')!
        .click(),
    );
    expect(fetchMock.mock.calls.some(([path]) => path.includes('/apply'))).toBe(false);
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '导出')!
        .click();
      await Promise.resolve();
    });
    const exportCall = fetchMock.mock.calls.find(([path]) => path.endsWith('/export-pack'))!;
    expect(JSON.parse(exportCall[1]!.body as string)).toEqual({
      modules: [{ moduleId: 'music-one', expectedRevision: 'm1' }],
      presets: [],
    });
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '使用')!
        .click();
      await Promise.resolve();
    });
    const applyCall = fetchMock.mock.calls.find(([path]) => path.endsWith('/apply'))!;
    expect(JSON.parse(applyCall[1]!.body as string)).toMatchObject({
      moduleId: 'music-one',
      expectedRevision: 'm1',
      expectedActiveRevision: 'a1',
    });
    expect(click).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    element.remove();
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('keeps the old camera configuration visible after a failed recovery and restores it without applying', async () => {
  const module = { id: 'hud-one', name: 'HUD', kind: 'hud', revision: 'h1', origin: null };
  let pending = true;
  let restoreSucceeds = false;
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    if (path === '/local/v1/broadcast-presets')
      return Promise.resolve({
        ok: true,
        json: async () => ({ modules: [module], presets: [], active: { revision: 'a1' } }),
      });
    if (path === '/local/v1/broadcast-modules')
      return Promise.resolve({
        ok: true,
        json: async () => ({ modules: [{ module, builtin: true }] }),
      });
    if (path === '/local/v1/broadcast-config/pending-camera')
      return Promise.resolve({
        ok: true,
        json: async () => ({
          pending: pending
            ? {
                catalog: { presets: [{ id: 'old', preset: { name: '原运镜' } }] },
                automaticEnabled: true,
              }
            : null,
        }),
      });
    if (path.endsWith('/pending-camera/restore')) {
      expect(options?.body).toBe('{}');
      if (!restoreSucceeds) return Promise.resolve({ ok: false, status: 503 });
      pending = false;
      return Promise.resolve({
        ok: true,
        json: async () => ({ restored: [{ moduleId: 'new-camera' }] }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const imported = vi.fn();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<ResourceModules query="" category="camera" onImported={imported} />);
      await Promise.resolve();
    });
    expect(element.textContent).toContain('原运镜');
    const restore = () =>
      [...element.querySelectorAll('button')].find(
        (button) => button.textContent === '恢复运镜配置',
      )!;
    await act(async () => {
      restore().click();
      await Promise.resolve();
    });
    expect(element.textContent).toContain('原配置仍会保留');
    expect(element.textContent).toContain('原运镜');
    restoreSucceeds = true;
    await act(async () => {
      restore().click();
      await Promise.resolve();
    });
    expect(element.textContent).toContain('已恢复为草稿，尚未使用');
    expect(imported).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/apply'))).toBe(false);
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
