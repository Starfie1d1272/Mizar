// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  obsCommand:
    vi.fn<
      (
        action: 'open' | 'check' | 'repair' | 'configure',
        body?: Record<string, unknown>,
      ) => Promise<unknown>
    >(),
}));

vi.mock('../src/workspace/obs-client', () => ({
  useObsStatus: () => ({
    connection: 'connected',
    currentScene: '比赛主画面',
    port: 5555,
    sceneAligned: true,
    streaming: false,
    recording: false,
    passwordConfigured: true,
    video: null,
    findings: [],
  }),
  obsCommand: mocks.obsCommand,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: vi.fn() }));
vi.mock('../src/preparation/client', () => ({ openTool: vi.fn(), useLocalRead: () => null }));
vi.mock('../src/operator/RivalHubPreparationPanel', () => ({
  RivalHubPreparationPanel: () => null,
}));

import { Settings } from '../src/preparation/Settings';

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.obsCommand.mockReset().mockResolvedValue({ findings: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  vi.restoreAllMocks();
});

describe('OBS connection settings', () => {
  it('preserves a saved password when saving only the port and clears it only on explicit action', async () => {
    act(() => root!.render(<Settings tab="obs" />));
    const form = container.querySelector('form');
    expect(form).not.toBeNull();

    await act(async () => {
      form!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.obsCommand).toHaveBeenNthCalledWith(1, 'configure', { port: 5555 });
    expect(mocks.obsCommand).toHaveBeenNthCalledWith(2, 'check');

    const clearButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('清除已保存密码'),
    );
    expect(clearButton).toBeDefined();
    await act(async () => {
      clearButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.obsCommand).toHaveBeenNthCalledWith(3, 'configure', {
      port: 5555,
      password: '',
    });
    expect(mocks.obsCommand).toHaveBeenNthCalledWith(4, 'check');
  });
});
