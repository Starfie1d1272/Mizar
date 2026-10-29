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
    active: { revision: 'active', sourcePreset: null, adjusted: false },
  };
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    void options;
    return path === '/local/v1/broadcast-presets'
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(view) })
      : Promise.resolve({ ok: true });
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
