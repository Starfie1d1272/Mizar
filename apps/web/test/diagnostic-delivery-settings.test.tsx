// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  status: {
    available: true,
    configured: false,
    consent: false,
    paused: false,
    queuedBatches: 3,
    queuedBytes: 1000,
    acknowledged: 0,
    deletionPending: 0,
  },
  native:
    vi.fn<(command: string, args?: Record<string, unknown>, task?: unknown) => Promise<unknown>>(),
  command: vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
}));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: () => mocks.status,
  command: mocks.command,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.native }));
import { Cs2ConsoleSettings } from '../src/debug/Cs2ConsoleSettings';
import { DiagnosticDeliverySettings } from '../src/debug/DiagnosticDeliverySettings';
import { DiagnosticDeliveryNotice } from '../src/debug/DiagnosticDeliveryNotice';
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.native.mockReset();
  delete window.__TAURI_INTERNALS__;
  mocks.status = {
    available: true,
    configured: false,
    consent: false,
    paused: false,
    queuedBatches: 3,
    queuedBytes: 1000,
    acknowledged: 0,
    deletionPending: 0,
  };
  mocks.command.mockReset().mockImplementation((path, body) => {
    const value = body as { enabled?: boolean; paused?: boolean };
    if (path.endsWith('/consent'))
      mocks.status = { ...mocks.status, consent: value.enabled === true };
    if (path.endsWith('/pause')) mocks.status = { ...mocks.status, paused: value.paused === true };
    return Promise.resolve({});
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.__TAURI_INTERNALS__;
});
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((v) => v.textContent?.includes(text))!;
it('offers local reporting without an ineffective consent control when sending is unavailable', () => {
  act(() => root.render(<DiagnosticDeliverySettings />));
  expect(mocks.command).not.toHaveBeenCalled();
  expect(container.textContent).toContain('暂不可用');
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(button('保存问题标记')).toBeDefined();
});
it('requires consent before sending and keeps pause separate from withdrawal', async () => {
  mocks.status.configured = true;
  act(() => root.render(<DiagnosticDeliverySettings />));
  expect(mocks.command).not.toHaveBeenCalled();
  expect(container.textContent).toContain('维护者管理的 Cloudflare');
  expect(container.textContent).toContain('七天');
  expect(button('同意并开启').disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async () => {
    button('同意并开启').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenCalledWith('/operator/diagnostics/consent', {
    enabled: true,
    revision: 'technical-diagnostics-v3',
  });
  await act(async () => {
    button('暂停发送').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenLastCalledWith('/operator/diagnostics/pause', { paused: true });
  expect(container.textContent).toContain('已暂停发送。');
  await act(async () => {
    button('确认关闭并请求删除').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenLastCalledWith('/operator/diagnostics/consent', {
    enabled: false,
    revision: 'technical-diagnostics-v3',
  });
  mocks.status.deletionPending = 1;
  act(() => root.render(<DiagnosticDeliverySettings />));
  expect(container.textContent).toContain('删除请求等待同步');
});
it('acknowledges a saved marker briefly and shows write failures beside the action', async () => {
  act(() => root.render(<DiagnosticDeliverySettings />));
  await act(async () => {
    button('保存问题标记').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenCalledWith(
    '/operator/diagnostics/report',
    expect.objectContaining({ category: 'hud' }),
  );
  expect(container.textContent).toContain('已记录问题时间。');
  mocks.command.mockRejectedValueOnce(new Error('问题标记未确认写入'));
  await act(async () => {
    button('保存问题标记').click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role=alert]')?.textContent).toContain('问题标记未确认写入');
});

async function openConsole() {
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
  });
}
it('keeps native console capture off and makes its separate consent explicit before invoking a mutation', async () => {
  act(() => root.render(<Cs2ConsoleSettings />));
  expect(container.textContent).toBe('');
  expect(mocks.native).not.toHaveBeenCalled();
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  mocks.native.mockResolvedValue({
    enabled: false,
    generation: null,
    runtime: { phase: 'disabled' },
  });
  act(() => root.render(<Cs2ConsoleSettings />));
  expect(mocks.native).not.toHaveBeenCalled();
  await openConsole();
  const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.checked).toBe(false);
  expect(container.textContent).toContain('可能包含聊天并持续增长');
  expect(container.textContent).toContain('不清空或删除游戏日志');
  await act(async () => {
    checkbox.click();
    await Promise.resolve();
  });
  expect(mocks.native).not.toHaveBeenCalledWith(
    'set_cs2_console_capture',
    expect.anything(),
    expect.anything(),
  );
  mocks.native.mockResolvedValueOnce({ enabled: true, generation: 'a'.repeat(64) });
  await act(async () => {
    button('保存技术日志设置').click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenCalledWith(
    'set_cs2_console_capture',
    { enabled: true, expectedGeneration: null },
    expect.objectContaining({ trigger: 'user', taskId: expect.any(String) as unknown }),
  );
});
it('keeps a failed console change visible and lets a memory-only revocation be retried', async () => {
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  mocks.native.mockResolvedValue({
    enabled: true,
    generation: 'a'.repeat(64),
    runtime: { phase: 'reading' },
  });
  act(() => root.render(<Cs2ConsoleSettings />));
  await openConsole();
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await Promise.resolve();
  });
  mocks.native.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_TECHNICAL_DETAIL'));
  mocks.native.mockResolvedValue({
    enabled: false,
    generation: 'b'.repeat(64),
    revocationPending: true,
  });
  await act(async () => {
    button('保存技术日志设置').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('未能完整保存');
  expect(container.textContent).not.toContain('PRIVATE_NATIVE_TECHNICAL_DETAIL');
  expect(container.textContent).toContain('当前已停止读取');
  expect(button('保存技术日志设置').disabled).toBe(false);
  mocks.native.mockResolvedValueOnce({
    enabled: false,
    generation: 'c'.repeat(64),
    revocationPending: false,
  });
  await act(async () => {
    button('保存技术日志设置').click();
    await Promise.resolve();
  });
  expect(mocks.native).toHaveBeenLastCalledWith(
    'set_cs2_console_capture',
    { enabled: false, expectedGeneration: 'b'.repeat(64) },
    expect.objectContaining({ trigger: 'user' }),
  );
  expect(container.textContent).not.toContain('未能完整保存');
});

it('does not let a stale console status response overwrite a newly saved consent', async () => {
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  mocks.native
    .mockResolvedValueOnce({ enabled: false, generation: null })
    .mockImplementationOnce(() => pending)
    .mockResolvedValueOnce({ enabled: true, generation: 'd'.repeat(64) });
  act(() => root.render(<Cs2ConsoleSettings />));
  await openConsole();
  await act(async () => {
    button('重新读取设置').click();
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await Promise.resolve();
  });
  await act(async () => {
    button('保存技术日志设置').click();
    await Promise.resolve();
  });
  await act(async () => {
    release({ enabled: false, generation: null });
    await Promise.resolve();
  });
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
  expect(button('保存技术日志设置').disabled).toBe(true);
});

function showNotice() {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  mocks.status.configured = true;
  act(() => root.render(<DiagnosticDeliveryNotice />));
}
it('defaults the choice on but waits for confirmation before sending', async () => {
  showNotice();
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
  expect(container.textContent).toContain('并非匿名数据');
  expect(container.textContent).toContain('Cloudflare');
  expect(mocks.command).not.toHaveBeenCalled();
  await act(async () => {
    button('确认并继续').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenLastCalledWith('/operator/diagnostics/consent', {
    enabled: true,
    revision: 'technical-diagnostics-v3',
  });
  expect(container.textContent).toBe('');
});
it('lets the user turn the default off and remembers the choice', async () => {
  showNotice();
  act(() => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async () => {
    button('确认并继续').click();
    await Promise.resolve();
  });
  expect(mocks.command).not.toHaveBeenCalled();
  act(() => root.render(null));
  act(() => root.render(<DiagnosticDeliveryNotice />));
  expect(container.textContent).toBe('');
});
it('closing the untouched dialog stays off and does not invite again', () => {
  showNotice();
  act(() => button('关闭').click());
  expect(mocks.command).not.toHaveBeenCalled();
  act(() => root.render(null));
  act(() => root.render(<DiagnosticDeliveryNotice />));
  expect(container.textContent).toBe('');
});
it('persists off after an uncertain enable instead of assuming it stayed disabled', async () => {
  showNotice();
  mocks.command.mockRejectedValueOnce(new Error('lost response'));
  await act(async () => {
    button('确认并继续').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('设置未能确认保存');
  await act(async () => {
    button('关闭').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenLastCalledWith('/operator/diagnostics/consent', {
    enabled: false,
    revision: 'technical-diagnostics-v3',
  });
  expect(container.textContent).toBe('');
});
it('waits for a pending explicit choice and keeps a save failure actionable', async () => {
  showNotice();
  let reject!: (error: Error) => void;
  mocks.command.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  await act(async () => {
    button('确认并继续').click();
    await Promise.resolve();
  });
  expect(button('正在保存').disabled).toBe(true);
  act(() => button('关闭').click());
  expect(container.querySelector('dialog')?.open).toBe(true);
  await act(async () => {
    reject(new Error('failed'));
    await Promise.resolve();
  });
  expect(container.textContent).toContain('设置未能确认保存');
  expect(button('确认并继续').disabled).toBe(false);
});
it('does not invite existing participants or unavailable installations', () => {
  act(() => root.render(<DiagnosticDeliveryNotice />));
  expect(container.textContent).toBe('');
  mocks.status = { ...mocks.status, configured: true, consent: true };
  act(() => root.render(<DiagnosticDeliveryNotice />));
  expect(container.textContent).toBe('');
  expect(mocks.command).not.toHaveBeenCalled();
});
