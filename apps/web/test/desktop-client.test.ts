// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopInvoke } from '../src/workspace/client';

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('desktop command errors', () => {
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
