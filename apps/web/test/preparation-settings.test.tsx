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
import { ResourceSettings } from '../src/preparation/ResourceSettings';

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
      buttons.find((button) => button.textContent === '一键安装 / 修复 GSI')!.click();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('GSI 已安装，请重新启动');
    expect(container.textContent).toContain('请处理上方列出的问题');
  });
});

describe('official resource cache status', () => {
  const status = {
    packId: 'official:epl-default',
    phase: 'missing',
    activeVersion: null,
    preparedVersion: null,
    failure: null,
  };
  async function renderResource(
    next: {
      packId: string;
      phase: string;
      activeVersion: string | null;
      preparedVersion: string | null;
      failure: string | null;
    } = status,
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ resources: [next] }),
      }),
    );
    await act(async () => {
      root!.render(<ResourceSettings />);
      await Promise.resolve();
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  it('distinguishes missing cache from bundled Full availability and prepared from active', async () => {
    await renderResource();
    expect(container.textContent).toContain('没有活动缓存');
    expect(container.textContent).toContain('此处不检查随包文件是否完整');
    expect(container.textContent).not.toContain('素材缺失');
    act(() => root!.unmount());
    root = createRoot(container);
    await renderResource({ ...status, phase: 'ready', preparedVersion: '1.2.0' });
    expect(container.textContent).toContain('素材已验证，尚未激活');
    expect(container.textContent).toContain('已准备版本1.2.0');
    expect(container.textContent).toContain('活动版本未激活');
  });

  it('preserves the distinction between failed operation and retained active version', async () => {
    await renderResource({
      ...status,
      phase: 'failed',
      activeVersion: '1.2.0',
      failure: 'resource_file_corrupt',
    });
    expect(container.textContent).toContain('最近操作失败');
    expect(container.textContent).toContain('活动版本1.2.0');
    expect(container.textContent).toContain('仍保留活动版本，实际读取可能失败');
    expect(container.textContent).toContain('resource_file_corrupt');
    expect(container.textContent).not.toContain('重新下载安装器即可修复');
  });

  it('recovers a failed status query through a read-only retry', async () => {
    const fetcher = vi
      .fn<
        (
          path: string,
          options: { cache: string; method?: string; signal: AbortSignal },
        ) => Promise<unknown>
      >()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ resources: [{ ...status, phase: 'ready', activeVersion: '1.2.0' }] }),
      });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      root!.render(<ResourceSettings />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('暂时无法查询素材缓存');
    expect(container.textContent).not.toContain('活动版本');
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '重新检查缓存状态')!
        .click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('验证完成');
    expect(container.textContent).not.toContain('暂时无法查询素材缓存');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [path, options] of fetcher.mock.calls) {
      expect(path).toBe('/local/v1/resources');
      expect(options).toMatchObject({ cache: 'no-store' });
      expect(options.method).toBeUndefined();
    }
  });
});
