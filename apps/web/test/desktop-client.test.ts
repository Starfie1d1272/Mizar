// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopInvoke } from '../src/workspace/client';
import { obsCommand } from '../src/workspace/obs-client';

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe('desktop command errors', () => {
  it('launches OBS through the desktop host rather than the owned Companion process', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ executablePath: 'D:\\OBS\\obs64.exe' }),
    });
    vi.stubGlobal('fetch', fetch);
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    await obsCommand('open');
    expect(fetch).toHaveBeenCalledWith('/operator/obs/launch-target', expect.any(Object));
    expect(invoke).toHaveBeenCalledWith('launch_obs', { executablePath: 'D:\\OBS\\obs64.exe' });
    delete window.__TAURI_INTERNALS__;
    await obsCommand('open');
    expect(fetch).toHaveBeenLastCalledWith('/operator/obs/open', expect.any(Object));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('preserves the Rust string rejection as an Error for settings and workspace messages', async () => {
    window.__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue('GSI 配置未完成；请核对安装目录与配置冲突后重试。'),
    };
    await expect(desktopInvoke('configure_gsi', { restore: false, choose: false })).rejects.toThrow(
      'GSI 配置未完成；请核对安装目录与配置冲突后重试。',
    );
  });

  it('keeps an existing Error and supplies a readable fallback for an unknown rejection', async () => {
    const error = new Error('现场窗口未能打开。');
    const invoke = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(null);
    window.__TAURI_INTERNALS__ = { invoke };
    await expect(desktopInvoke('present_production')).rejects.toBe(error);
    await expect(desktopInvoke('present_production')).rejects.toThrow('桌面操作失败，请重试。');
  });
});
