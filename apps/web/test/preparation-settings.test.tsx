// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  beginObsConfiguration: vi.fn(() => ({
    ready: Promise.resolve(false),
    finish: vi.fn().mockResolvedValue({ reason: 'not_owned', message: '' }),
  })),
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
    programEvidence: null,
  }),
  obsCommand: mocks.obsCommand,
  beginObsConfiguration: mocks.beginObsConfiguration,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.invoke }));
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
  mocks.invoke.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
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

    expect(mocks.obsCommand).toHaveBeenCalledWith('configure', { port: 5555 });

    const clearButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('清除已保存密码'),
    );
    expect(clearButton).toBeDefined();
    await act(async () => {
      clearButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.obsCommand).toHaveBeenCalledWith('configure', {
      port: 5555,
      password: '',
    });
  });
});
