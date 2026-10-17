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
it('requires explicit informed consent and separates pause with retained queue from withdrawal', async () => {
  act(() => root.render(<DiagnosticDeliverySettings />));
  expect(mocks.command).not.toHaveBeenCalled();
  expect(container.textContent).toContain('并非匿名数据');
  expect(container.textContent).toContain('不会使用 R2');
  expect(button('同意并保存设置').disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async () => {
    button('同意并保存设置').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenCalledWith('/operator/diagnostics/consent', {
    enabled: true,
    revision: 'technical-diagnostics-v1',
  });
  await act(async () => {
    button('暂停回传').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenLastCalledWith('/operator/diagnostics/pause', { paused: true });
  expect(container.textContent).toContain('待传 3 批');
  expect(container.textContent).toContain('已暂停回传，本机记录和待传副本继续保留');
  await act(async () => {
    button('确认撤回并请求删除').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenLastCalledWith('/operator/diagnostics/consent', {
    enabled: false,
    revision: 'technical-diagnostics-v1',
  });
});
it('does not claim cloud receipt when a local marker is saved and shows a nearby failure when it cannot be saved', async () => {
  act(() => root.render(<DiagnosticDeliverySettings />));
  await act(async () => {
    button('保存问题标记').click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenCalledWith(
    '/operator/diagnostics/report',
    expect.objectContaining({ category: 'hud' }),
  );
  expect(container.textContent).toContain('这不代表云端已收到');
  mocks.command.mockRejectedValueOnce(new Error('问题标记未确认写入'));
  await act(async () => {
    button('保存问题标记').click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role=alert]')?.textContent).toContain('问题标记未确认写入');
});
