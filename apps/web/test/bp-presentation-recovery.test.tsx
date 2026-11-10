// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  view: {
    mode: 'full',
    revision: 'original',
    recovery: { reason: 'EACCES', message: 'denied' },
  } as {
    mode: string;
    revision: string;
    recovery: { reason: string; message: string } | null;
  },
  command: vi.fn(),
}));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: () => state.view,
  command: state.command,
}));
vi.mock('@mizar/hud-view', () => ({
  BpPresentation: () => null,
  BpCompactPresentation: () => null,
}));
import { BpPresentationSettingsPanel } from '../src/preparation/BpPresentationSettings';

it('offers an explicit same-mode save and keeps recovery available after failure', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    state.command.mockRejectedValueOnce(new Error('保存失败，请重试。'));
    await act(async () => root.render(<BpPresentationSettingsPanel />));
    const save = () => host.querySelector('button')!;
    expect(host.textContent).toContain('原文件已保留');
    await act(async () => save().click());
    expect(state.command).toHaveBeenCalledWith('/operator/bp-presentation', {
      mode: 'full',
      expectedRevision: 'original',
    });
    expect(host.textContent).toContain('保存失败，请重试。');
    expect(save().disabled).toBe(false);
    state.command.mockImplementationOnce(async () => {
      state.view.recovery = null;
    });
    await act(async () => save().click());
    expect(state.command).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('原文件已保留');
    expect(host.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
