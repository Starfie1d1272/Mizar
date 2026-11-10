// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('../src/debug/control-journal', () => ({
  flushControlSnapshots: () => {},
  flushControlEvidence: async () => ({}),
  sendControlEvidence: async () => {},
}));
vi.mock('../src/debug/performance-journal', () => ({ flushPerformanceJournal: async () => {} }));
vi.mock('../src/debug/export-host-pin', () => ({
  pinHostEvidence: async () => undefined,
  releaseHostPinWhenSettled: () => {},
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: vi.fn() }));
import { SupportExport } from '../src/debug/SupportExport';

it('distinguishes unconfirmed cache ownership from a connection failure or endless retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        exportId: 'synthetic-export',
        phase: 'failed',
        error: 'Error: export_cache_lease_unconfirmed',
      }),
    ),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SupportExport />));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存诊断包"]')!.click(),
    );
    expect(host.textContent).toContain('占用状态无法确认');
    expect(host.textContent).toContain('完成或取消保存后重试');
    expect(host.textContent).toContain('当前不能安全自动移除');
    expect(host.textContent).toContain('原始日志已保留');
    expect(host.textContent).not.toContain('请检查本地服务连接');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
