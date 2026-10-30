// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Button } from '../src/ui/primitives';

it('preserves a caller busy state and label without changing the loading behavior', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Button aria-busy>正在重建本机 HUD…</Button>));
    let button = host.querySelector('button')!;
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('正在重建本机 HUD…');
    await act(async () =>
      root.render(
        <Button loading aria-busy={false}>
          保存
        </Button>,
      ),
    );
    button = host.querySelector('button')!;
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    await act(async () => root.render(<Button>恢复本机 HUD</Button>));
    expect(host.querySelector('button')!.hasAttribute('aria-busy')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
