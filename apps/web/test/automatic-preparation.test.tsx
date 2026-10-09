// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  obs: vi.fn(),
  status: { connection: 'connected', streaming: false, recording: false, findings: [] },
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.invoke }));
vi.mock('../src/workspace/obs-client', () => ({
  useObsStatus: () => mocks.status,
  obsCommand: mocks.obs,
}));
import { AutomaticPreparation } from '../src/preparation/AutomaticPreparation';
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.clearAllMocks();
});
describe('automatic first preparation', () => {
  it('prepares GSI and OBS without an additional operator click', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockResolvedValue({ pending: false, busy: false });
    mocks.obs.mockResolvedValue({ alreadyRunning: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<AutomaticPreparation />);
        await Promise.resolve();
      });
      expect(mocks.invoke).toHaveBeenCalledWith('ensure_gsi');
      expect(mocks.obs).toHaveBeenCalledWith('open');
      expect(mocks.obs).toHaveBeenCalledWith('ensure');
    } finally {
      act(() => root.unmount());
    }
  });
  it('preserves pending game configuration and never repairs an active output', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockResolvedValue({ pending: true });
    mocks.status.streaming = true;
    mocks.obs.mockResolvedValue({ alreadyRunning: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<AutomaticPreparation />);
        await Promise.resolve();
      });
      expect(mocks.invoke).not.toHaveBeenCalledWith('ensure_gsi');
      expect(mocks.obs).not.toHaveBeenCalledWith('ensure');
      expect(container.textContent).toContain('待处理');
    } finally {
      act(() => root.unmount());
      mocks.status.streaming = false;
    }
  });
});
