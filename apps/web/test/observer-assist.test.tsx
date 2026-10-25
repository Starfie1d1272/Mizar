// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_OBSERVER_SETTINGS } from '@mizar/protocol/assist';
const mocks = vi.hoisted(() => ({
  view: {
    settings: {
      enabled: false,
      expectedDelaySeconds: 120,
      leadSeconds: 7,
    },
    connection: null,
  },
  command: vi.fn(),
  native: vi.fn(),
  observer: ((): Record<string, unknown> => ({}))(),
}));
vi.mock('../src/preparation/client', () => ({
  useLocalRead: () => mocks.view,
  command: mocks.command,
}));
vi.mock('../src/workspace/client', () => ({ desktopInvoke: mocks.native }));
vi.mock('../src/preparation/cs2-status', () => ({ useCs2Status: () => ({ status: null }) }));
vi.mock('../src/realtime', () => ({
  useLocalChannelClient: () => ({ subscribe: () => () => {}, getSnapshot: () => mocks.observer }),
}));
import { ObserverSettingsPanel } from '../src/preparation/ObserverSettings';
import { ObserverHints } from '../src/workspace/ObserverHints';
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.view.settings = { ...DEFAULT_OBSERVER_SETTINGS };
  mocks.command.mockReset().mockResolvedValue({});
  mocks.native.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.__TAURI_INTERNALS__;
});
it('offers the two timing controls and saves observer preferences independently of game controls', async () => {
  window.__TAURI_INTERNALS__ = { invoke: <T,>() => Promise.resolve(undefined as T) };
  act(() => root.render(<ObserverSettingsPanel />));
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type=number]')].map((e) => e.value),
  ).toEqual(['120', '7']);
  expect(container.textContent).toContain('113');
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((e) => e.textContent?.includes('保存观察辅助'))!
      .click();
    await Promise.resolve();
  });
  expect(mocks.command).toHaveBeenCalledWith('/operator/observer-assist', {
    action: 'configure',
    settings: DEFAULT_OBSERVER_SETTINGS,
  });
  expect(mocks.native).not.toHaveBeenCalled();
});
it('keeps the disabled feature out of connection preparation and the workbench', () => {
  mocks.observer = { state: 'live', current: { payload: { availability: 'unavailable' } } };
  act(() =>
    root.render(
      <>
        <ObserverHints />
      </>,
    ),
  );
  expect(container.innerHTML).toBe('');
});
it('shows private slots and countdowns from the assist channel, and clears on reconnect', () => {
  mocks.observer = {
    state: 'live',
    current: {
      payload: {
        observer: {
          state: 'ready',
          leadSeconds: 7,
          hints: [
            {
              id: 'test',
              remainingSeconds: 7,
              attacker: { name: 'Long player name', observerSlot: 2 },
              victim: { name: 'Victim', observerSlot: 9 },
            },
          ],
        },
      },
    },
  };
  act(() => root.render(<ObserverHints />));
  expect(container.textContent).toContain('7 秒后');
  expect([...container.querySelectorAll('kbd')].map((e) => e.textContent)).toEqual(['3', '0']);
  mocks.observer = { state: 'reconnecting' };
  act(() => root.render(<ObserverHints />));
  expect(container.innerHTML).toBe('');
});
