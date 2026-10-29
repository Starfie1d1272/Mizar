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
