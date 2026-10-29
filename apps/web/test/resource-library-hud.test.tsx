// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const { mutate, apply, read } = vi.hoisted(() => ({
  mutate: vi.fn(),
  apply: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../src/operator/hud-preset-file', () => ({ readHudPresetFile: read }));
vi.mock('../src/realtime/hud-config-client', () => ({
  HudConfigMutationError: class extends Error {
    status = 409;
  },
  mutateHudConfig: mutate,
  useHudConfigEditorClient: () => ({ status: 'ready', revision: 'revision', applyResponse: apply }),
}));
import { HudPackages } from '../src/resource-library/HudPackages';

it('imports an existing HUD preset through the draft editor', async () => {
  read.mockResolvedValue({ preset: { name: '我的视觉' } });
  mutate.mockResolvedValue({ editor: { revision: 'next' } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<HudPackages />));
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'hud.json')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mutate).toHaveBeenCalledWith({
      kind: 'import-preset-pack',
      value: { preset: { name: '我的视觉' } },
      expectedEditorRevision: 'revision',
    });
    expect(apply).toHaveBeenCalledWith({ revision: 'next' });
    expect(container.textContent).toContain('已保存「我的视觉」');
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  }
});
