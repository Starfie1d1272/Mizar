// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  status: {
    automatic: true,
    notificationPending: false,
    notificationSafe: true,
    candidate: null,
    mulnxNotificationPending: true,
    mulnx: { installed: 'v1', latest: 'v2', notificationIdentity: 'a' },
  },
}));
vi.mock('../src/preparation/client', () => ({ useLocalRead: () => fixture.status }));
import { UpdateNotification } from '../src/preparation/UpdateNotification';

it('replaces an obsolete MulNX notice and defers its return while typing', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
  const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  const host = document.createElement('div');
  const input = document.createElement('input');
  document.body.append(input, host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(<UpdateNotification />);
      await Promise.resolve();
    });
  };
  try {
    await render();
    expect(host.querySelector('dialog')?.open).toBe(true);
    expect(host.textContent).toContain('MulNX v2');
    fixture.status = {
      ...fixture.status,
      mulnx: { installed: 'v1', latest: 'v3', notificationIdentity: 'b' },
    };
    await render();
    expect(host.textContent).toContain('MulNX v3');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fixture.status = { ...fixture.status, notificationSafe: false };
    await render();
    expect(host.querySelector('dialog')?.open).toBe(false);
    input.focus();
    fixture.status = { ...fixture.status, notificationSafe: true };
    await render();
    expect(host.querySelector('dialog')?.open).toBe(false);
    input.blur();
    const otherDialog = document.createElement('dialog');
    otherDialog.open = true;
    document.body.append(otherDialog);
    await render();
    expect(host.querySelector('dialog')?.open).toBe(false);
    otherDialog.remove();
    await render();
    expect(host.querySelector('dialog')?.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    input.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.__TAURI_INTERNALS__;
  }
});
