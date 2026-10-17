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
  command: vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
}));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: () => mocks.status,
  command: mocks.command,
}));
import { DiagnosticDeliverySettings } from '../src/debug/DiagnosticDeliverySettings';
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
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
    revision: 'technical-diagnostics-v1',
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
    revision: 'technical-diagnostics-v1',
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
