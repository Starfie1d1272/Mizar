// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MusicPackages } from '../src/resource-library/MusicPackages';

it('imports a music package as a draft', async () => {
  const fetchMock = vi.fn((path: string) => {
    if (path === '/local/v1/broadcast-presets')
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            modules: [{ kind: 'music', id: 'one', revision: 'r1', name: '背景音乐' }],
          }),
      });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ reused: false }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<MusicPackages query="" />);
      await Promise.resolve();
    });
    expect(element.textContent).toContain('背景音乐');
    const input = element.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('选择音乐分享包');
    const file = new File(['zip'], 'music.mizarpack');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(element.textContent).toContain('音乐配置已保存。');
    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/resource-library/import-music-pack',
      expect.objectContaining({ method: 'POST', body: file }),
    );
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
