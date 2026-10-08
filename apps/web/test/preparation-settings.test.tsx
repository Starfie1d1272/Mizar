// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
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

describe('CS2 installation and conflict guidance', () => {
  const status = {
    detected: true,
    installed: true,
    conflict: true,
    fileConflict: true,
    endpointConflict: true,
    readFailed: false,
    candidateCount: 1,
    cfgPath: 'C:\\Steam\\game\\csgo\\cfg\\gamestate_integration_mizar.cfg',
    conflictFiles: ['C:\\Steam\\game\\csgo\\cfg\\gamestate_integration_duplicate.cfg'],
    issues: [
      { code: 'gsi-file-changed', message: '文件与安装记录不一致，请先备份当前文件。' },
      { code: 'endpoint-conflict', message: '其他配置也向相同地址发送数据，请检查下列文件。' },
    ],
  };
  async function render(next = status) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    mocks.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'gsi_status' ? next : null),
    );
    await act(async () => {
      root!.render(<Settings tab="gsi" />);
      await Promise.resolve();
    });
  }
  it('shows simultaneous conflicts and lets users select a path even after detection succeeds', async () => {
    await render();
    expect(container.textContent).toContain('文件与安装记录不一致');
    expect(container.textContent).toContain('其他配置也向相同地址发送数据');
    expect(container.textContent).toContain('gamestate_integration_duplicate.cfg');
    const choose = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '选择 CS2 安装目录',
    )!;
    expect(choose.disabled).toBe(false);
    mocks.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'gsi_status' ? status : true),
    );
    await act(async () => {
      choose.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith('select_cs2_installation', { executable: false });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'configure_gsi')).toBe(false);
    expect(container.textContent).toContain('已保存 CS2 安装位置');
  });
  it('does not report a cancelled selection or unresolved installation conflict as success', async () => {
    await render();
    mocks.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'gsi_status' ? status : false),
    );
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => {
      buttons.find((button) => button.textContent === '选择 cs2.exe')!.click();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('已保存 CS2 安装位置');
    await act(async () => {
      buttons.find((button) => button.textContent === '安装 / 修复 GSI')!.click();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('GSI 已安装，请重新启动');
    expect(container.textContent).toContain('请处理上方列出的问题');
  });
});
