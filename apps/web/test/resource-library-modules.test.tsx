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

it('reports a partial import instead of claiming every resource was imported', async () => {
  const fetchMock = vi.fn((path: string) => {
    if (path === '/local/v1/broadcast-presets')
      return Promise.resolve({
        ok: true,
        json: async () => ({ modules: [], presets: [], active: { revision: 'a1' } }),
      });
    if (path === '/local/v1/broadcast-modules')
      return Promise.resolve({ ok: true, json: async () => ({ modules: [] }) });
    if (path === '/operator/resource-library/check-pack')
      return Promise.resolve({
        ok: true,
        json: async () => ({
          name: '分享包',
          source: { digest: 'a'.repeat(64) },
          entries: [
            { entryId: 'hud', type: 'module', kind: 'hud', name: '实况 HUD', status: 'ready' },
            {
              entryId: 'camera',
              type: 'module',
              kind: 'camera',
              name: '镜头',
              status: 'dependency_missing',
            },
            {
              entryId: 'old',
              type: 'module',
              kind: 'music',
              name: '已删除音乐',
              status: 'removed',
            },
            {
              entryId: 'bad-1',
              type: 'module',
              kind: 'hud',
              name: '损坏 HUD 一',
              status: 'invalid',
              reason: 'package_invalid',
            },
            {
              entryId: 'bad-2',
              type: 'module',
              kind: 'hud',
              name: '损坏 HUD 二',
              status: 'invalid',
              reason: 'package_invalid',
            },
          ],
        }),
      });
    if (path.startsWith('/operator/resource-library/import-pack?'))
      return Promise.resolve({
        ok: true,
        json: async () => ({
          reused: false,
          mapping: { moduleEntries: { hud: ['new-hud'] } },
          entries: [
            { entryId: 'hud', type: 'module', kind: 'hud', result: 'imported' },
            { entryId: 'camera', type: 'module', kind: 'camera', result: 'unavailable' },
            { entryId: 'old', type: 'module', kind: 'music', result: 'not_selected' },
            {
              entryId: 'bad-1',
              type: 'module',
              kind: 'hud',
              status: 'invalid',
              result: 'not_selected',
            },
            {
              entryId: 'bad-2',
              type: 'module',
              kind: 'hud',
              status: 'invalid',
              result: 'not_selected',
            },
          ],
        }),
      });
    return Promise.resolve({ ok: true, json: async () => ({ pending: null }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<ResourceModules query="" category="all" onImported={() => {}} />);
      await Promise.resolve();
    });
    const input = element.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['zip'], 'pack.mizarpack')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(element.textContent).toContain('实况 HUD');
    expect(element.textContent).toContain('所需来源暂不可用，可先保存');
    const boxes = [...element.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, false, false, false]);
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '稍后继续')!
        .click();
    });
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '继续选择资源')!
        .click();
    });
    expect(
      [...element.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map(
        (box) => box.checked,
      ),
    ).toEqual([true, true, false, false, false]);
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '导入所选')!
        .click();
      await Promise.resolve();
    });
    const importCall = fetchMock.mock.calls.find(([path]) =>
      path.startsWith('/operator/resource-library/import-pack?'),
    )!;
    const query = new URL(importCall[0], 'http://localhost').searchParams;
    expect(JSON.parse(query.get('selection')!)).toEqual({
      modules: ['hud', 'camera'],
      presets: [],
    });
    expect(query.get('digest')).toBe('a'.repeat(64));
    expect(element.textContent).toContain('部分所选内容已保存');
    expect(element.textContent).toContain('实况 HUD · HUD：已导入');
    expect(element.textContent).toContain('损坏 HUD 一 · HUD：未导入：内容无效');
    expect(element.textContent).toContain('损坏 HUD 二 · HUD：未导入：内容无效');
    expect(element.textContent).toContain('镜头 · 运镜：未导入：所需来源不可用');
    expect(element.textContent).not.toContain('bad-1');
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '继续选择资源')!
        .click();
    });
    expect(
      [...element.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map(
        (box) => box.checked,
      ),
    ).toEqual([true, true, false, false, false]);
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});

it('names the resource and actionable reason returned by an export failure', async () => {
  const { exportFailure } = await import('../src/resource-library/export-error');
  const response = {
    status: 422,
    json: async () => ({ entries: [{ type: 'module', id: 'one', reason: 'resource_damaged' }] }),
  } as Response;
  expect(await exportFailure(response, [{ id: 'one', name: '场景背景' }], [])).toBe(
    '导出未完成：「场景背景」所需素材已损坏。',
  );
});

it('offers a recovery path for the unavailable active scene without blocking HUDs', async () => {
  const module = {
    id: 'scene-one',
    kind: 'program',
    name: '受损场景',
    revision: 'p1',
    origin: null,
    value: {},
  };
  const fetchMock = vi.fn((path: string) => {
    if (path === '/local/v1/broadcast-presets')
      return Promise.resolve({
        ok: true,
        json: async () => ({
          modules: [module],
          presets: [],
          active: { revision: 'a1', sourceModuleIds: { program: 'scene-one' } },
        }),
      });
    if (path === '/local/v1/broadcast-modules')
      return Promise.resolve({
        ok: true,
        json: async () => ({
          modules: [{ module, builtin: false, availability: { state: 'dependency_missing' } }],
        }),
      });
    if (path === '/local/v1/broadcast-config/migration')
      return Promise.resolve({
        ok: true,
        json: async () => ({ state: 'pending', reason: 'program_dependency_unavailable' }),
      });
    return Promise.resolve({ ok: true, json: async () => ({ pending: null }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const showAll = vi.fn();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<ResourceModules query="" category="all" onImported={showAll} />);
      await Promise.resolve();
    });
    expect(element.textContent).toContain('当前播出场景的背景不可用');
    expect(element.textContent).toContain('HUD 可继续使用');
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent === '检查场景资源')!
        .click();
      await Promise.resolve();
    });
    expect(showAll).toHaveBeenCalledOnce();
    expect(element.textContent).toContain('所需资源不可用');
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
