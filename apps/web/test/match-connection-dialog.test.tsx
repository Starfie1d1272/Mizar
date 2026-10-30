// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_OBSERVER_SETTINGS } from '@mizar/protocol/assist';
import { flushObserverPreparation } from '../src/preparation/observer-preparation';
import { MatchConnectionDialog } from '../src/preparation/MatchConnectionDialog';

const mocks = vi.hoisted(() => ({ command: vi.fn(), native: vi.fn() }));
vi.mock('../src/preparation/client', () => ({ command: mocks.command }));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.native }));
vi.mock('../src/workspace/ReviewDialog', () => ({
  isReviewWindow: () => false,
  closeReviewWindow: vi.fn(),
}));

it('reloads the revision and submits edited connection after host preparation fails', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const revisions = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ] as const;
  const view = (revision: string) => ({
    revision,
    settings: DEFAULT_OBSERVER_SETTINGS,
    connection: null,
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => view(revisions[0]) })
      .mockResolvedValueOnce({ ok: true, json: async () => view(revisions[2]) }),
  );
  mocks.command
    .mockReset()
    .mockResolvedValueOnce(view(revisions[1]))
    .mockResolvedValueOnce(view(revisions[2]));
  mocks.native
    .mockReset()
    .mockResolvedValueOnce({ useMulnx: true })
    .mockRejectedValueOnce(new Error('准备失败'))
    .mockResolvedValueOnce(undefined);
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find((e) => e.textContent === name)!;
  const input = () => container.querySelector<HTMLInputElement>('input')!;
  const change = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    act(() => root.render(<MatchConnectionDialog />));
    let result: Promise<unknown>;
    await act(async () => {
      result = flushObserverPreparation();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => change('connect 127.0.0.1:27025'));
    await act(async () => {
      button('确认本图连接').click();
      await Promise.resolve();
    });
    expect(input().disabled).toBe(true);
    await act(async () => {
      button('修改连接').click();
      await Promise.resolve();
    });
    expect(input().disabled).toBe(false);
    act(() => change('connect 127.0.0.2:27025'));
    await act(async () => {
      button('确认本图连接').click();
      await Promise.resolve();
    });
    expect(mocks.command).toHaveBeenLastCalledWith(
      '/operator/observer-assist',
      expect.objectContaining({
        expectedRevision: revisions[2],
        connection: expect.objectContaining({ earlyEndpoint: '127.0.0.2:27025' }),
      }),
    );
    expect(await result!).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete window.__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  }
});
