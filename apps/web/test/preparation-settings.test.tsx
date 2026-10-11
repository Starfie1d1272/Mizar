// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  captureUnavailable: false,
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
    programEvidence: mocks.captureUnavailable
      ? {
          state: 'measured',
          collection: 'mizar',
          sceneId: 'gameplay',
          composition: 'gameplay_overlay',
          sources: [],
          capture: {
            kind: 'game_capture',
            mode: 'window',
            target: 'cs2.exe',
            targetAvailable: false,
            cs2WindowCount: 0,
            videoActive: false,
            videoShowing: false,
            width: 0,
            height: 0,
          },
        }
      : null,
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
  mocks.captureUnavailable = false;
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
  it('shows configuration success only when no capture issue needs attention, then restores it after recovery', () => {
    act(() => root!.render(<Settings tab="obs" />));
    expect(container.textContent).toContain('Mizar 配置检查通过，请核对实际音画。');
    mocks.captureUnavailable = true;
    act(() => root!.render(<Settings tab="obs" />));
    expect(container.textContent).toContain(
      '捕获目标已不可选。请确认 CS2 已打开，再在 OBS 核对目标窗口。',
    );
    expect(container.textContent).not.toContain('Mizar 配置检查通过');
    mocks.captureUnavailable = false;
    act(() => root!.render(<Settings tab="obs" />));
    expect(container.textContent).not.toContain('捕获目标已不可选');
    expect(container.textContent).toContain('Mizar 配置检查通过，请核对实际音画。');
  });

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

describe('independent desktop status reads', () => {
  const configured = {
    installed: true,
    conflict: false,
    readFailed: false,
    issues: [],
    cfgPath: null,
  };
  const missing = { ...configured, installed: false };
  function desktop() {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  }
  it('reads status once after installation while notifying other listeners and using the final result', async () => {
    desktop();
    let installed = false;
    const notified = vi.fn();
    window.addEventListener('mizar:gsi-configured', notified);
    mocks.invoke.mockImplementation((command) => {
      if (command === 'configure_gsi') installed = true;
      return Promise.resolve(
        command === 'gsi_status'
          ? installed
            ? configured
            : missing
          : command === 'cs2_host_status'
            ? { found: true, managed: true }
            : null,
      );
    });
    try {
      await act(async () => {
        root!.render(<Settings tab="gsi" />);
        await Promise.resolve();
      });
      mocks.invoke.mockClear();
      await act(async () => {
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === '一键安装 / 修复 GSI')!
          .click();
        await Promise.resolve();
      });
      expect(mocks.invoke).toHaveBeenCalledWith('configure_gsi', { restore: false, choose: false });
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'gsi_status')).toHaveLength(
        1,
      );
      expect(
        mocks.invoke.mock.calls.filter(([command]) => command === 'cs2_host_status'),
      ).toHaveLength(1);
      expect(notified).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('GSI 文件已配置，请重新启动 CS2 以加载配置。');
      expect(container.textContent).not.toContain('待安装 GSI');
    } finally {
      window.removeEventListener('mizar:gsi-configured', notified);
    }
  });
  it('shows delayed GSI as checking and keeps successful GSI when CS2 fails, then recovers both independently', async () => {
    desktop();
    let resolveGsi!: (value: typeof configured) => void;
    const pendingGsi = new Promise<typeof configured>((resolve) => {
      resolveGsi = resolve;
    });
    mocks.invoke.mockImplementation((command) =>
      command === 'gsi_status'
        ? pendingGsi
        : command === 'cs2_host_status'
          ? Promise.reject(new Error('C:\\Users\\private\\secret.log password=private'))
          : Promise.resolve(null),
    );
    await act(async () => {
      root!.render(<Settings tab="gsi" />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('正在检测 GSI');
    expect(container.textContent).not.toContain('待安装 GSI');
    expect(container.textContent).toContain('无法读取 CS2 窗口状态');
    await act(async () => {
      resolveGsi(configured);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('GSI 文件已配置');
    expect(container.textContent).toContain('CS2 窗口读取失败');
    expect(container.textContent).not.toContain('password=private');
    mocks.invoke.mockImplementation((command) =>
      command === 'gsi_status'
        ? Promise.reject(new Error('CS2 与 GSI 检测失败（等待工具）。private/token=secret'))
        : command === 'cs2_host_status'
          ? Promise.resolve({ found: true, managed: true })
          : Promise.resolve(null),
    );
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '重新检查 CS2 与 GSI')!
        .click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('无法检查 GSI');
    expect(container.textContent).toContain('检测工具失败（等待工具）');
    expect(container.textContent).toContain('CS2 窗口已就绪');
    expect(container.textContent).not.toContain('GSI 文件已配置');
    expect(container.textContent).not.toContain('待安装 GSI');
    expect(container.textContent).not.toContain('token=secret');
  });
  it('ignores older reads and queries again after leaving and returning to settings', async () => {
    desktop();
    let resolveOldGsi!: (value: typeof configured) => void;
    let resolveOldCs2!: (value: { found: boolean; managed: boolean }) => void;
    const oldGsi = new Promise<typeof configured>((resolve) => {
      resolveOldGsi = resolve;
    });
    const oldCs2 = new Promise<{ found: boolean; managed: boolean }>((resolve) => {
      resolveOldCs2 = resolve;
    });
    mocks.invoke.mockImplementation((command) =>
      command === 'gsi_status'
        ? oldGsi
        : command === 'cs2_host_status'
          ? oldCs2
          : Promise.resolve(null),
    );
    await act(async () => {
      root!.render(<Settings tab="gsi" />);
      await Promise.resolve();
    });
    mocks.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === 'gsi_status'
          ? missing
          : command === 'cs2_host_status'
            ? { found: true, managed: true }
            : null,
      ),
    );
    await act(async () => {
      window.dispatchEvent(new Event('mizar:gsi-configured'));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('待安装 GSI');
    expect(container.textContent).toContain('CS2 窗口已就绪');
    await act(async () => {
      resolveOldGsi(configured);
      resolveOldCs2({ found: false, managed: false });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('待安装 GSI');
    expect(container.textContent).not.toContain('GSI 文件已配置');
    expect(container.textContent).toContain('CS2 窗口已就绪');
    act(() => root!.render(null));
    mocks.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === 'gsi_status'
          ? configured
          : command === 'cs2_host_status'
            ? { found: false, managed: false }
            : null,
      ),
    );
    const previousReads = mocks.invoke.mock.calls.filter(
      ([command]) => command === 'gsi_status',
    ).length;
    await act(async () => {
      root!.render(<Settings tab="gsi" />);
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'gsi_status')).toHaveLength(
      previousReads + 1,
    );
    expect(container.textContent).toContain('GSI 文件已配置');
    expect(container.textContent).not.toContain('待安装 GSI');
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
    expect(container.textContent).toContain('暂无独立缓存');
    expect(container.textContent).not.toContain('素材缺失');
    act(() => root!.unmount());
    root = createRoot(container);
    await renderResource({ ...status, phase: 'ready', preparedVersion: '1.2.0' });
    expect(container.textContent).toContain('已验证，待激活');
    expect(container.textContent).toContain('已准备版本1.2.0');
    expect(container.textContent).toContain('当前版本未激活');
  });

  it('preserves the distinction between failed operation and retained active version', async () => {
    await renderResource({
      ...status,
      phase: 'failed',
      activeVersion: '1.2.0',
      failure: 'resource_file_corrupt',
    });
    expect(container.textContent).toContain('最近操作失败');
    expect(container.textContent).toContain('当前版本1.2.0');
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === '查看诊断'),
    ).toBe(true);
    expect(container.textContent).toContain('resource_file_corrupt');
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
    expect(container.textContent).toContain('暂时无法查询');
    expect(container.textContent).not.toContain('当前版本');
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '刷新')!
        .click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('验证完成');
    expect(container.textContent).not.toContain('暂时无法查询');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [path, options] of fetcher.mock.calls) {
      expect(path).toBe('/local/v1/resources');
      expect(options).toMatchObject({ cache: 'no-store' });
      expect(options.method).toBeUndefined();
    }
  });
});
