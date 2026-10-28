// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SILENCED_MATCH_KEY } from '../src/workspace/review-silence';
vi.mock('../src/workspace/ReviewDialog', () => ({
  ReviewDialog: ({
    open,
    children,
    onClose,
  }: {
    open: boolean;
    children: React.ReactNode;
    onClose: () => void;
  }) =>
    open ? (
      <div data-review>
        {children}
        <button onClick={onClose}>关闭</button>
      </div>
    ) : null,
  isReviewWindow: () => false,
  closeReviewWindow: () => Promise.resolve(),
}));
vi.mock('../src/operator/RivalHubSyncControls', () => ({ RivalHubSyncControls: () => null }));
vi.mock('../src/debug/SupportExport', () => ({ SupportExport: () => null }));
import { SyncHealthAlert } from '../src/workspace/SyncHealthAlert';
it('silences repeated sync incidents for this match and keeps manual review available', () => {
  localStorage.clear();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (matchId: string, incidentId: string) =>
    act(() =>
      root.render(
        <SyncHealthAlert
          matchId={matchId}
          health={{ status: 'attention', reason: 'capacity', incidentId, deviceName: null }}
          isSource
          onOpen={async () => {}}
        />,
      ),
    );
  render('match-a', 'incident-1');
  expect(element.querySelector('[data-review]')).not.toBeNull();
  act(() => [...element.querySelectorAll('button')].find((b) => b.textContent === '关闭')!.click());
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'diagnostic-preference', newValue: '1' }),
    );
  });
  expect(element.querySelector('[data-review]')).toBeNull();
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(element.querySelector('[data-review]')).not.toBeNull();
  act(() => [...element.querySelectorAll('button')].find((b) => b.textContent === '关闭')!.click());
  act(() =>
    [...element.querySelectorAll('button')]
      .find((b) => b.textContent === '网站同步需处理')!
      .click(),
  );
  const silence = [...element.querySelectorAll('button')].find(
    (b) => b.textContent === '本场比赛不再自动弹出',
  )!;
  act(() => silence.click());
  expect(localStorage.getItem(SILENCED_MATCH_KEY)).toBe('match-a');
  render('match-a', 'incident-2');
  expect(element.querySelector('[data-review]')).toBeNull();
  act(() =>
    [...element.querySelectorAll('button')]
      .find((b) => b.textContent === '网站同步需处理')!
      .click(),
  );
  expect(element.querySelector('[data-review]')).not.toBeNull();
  render('match-b', 'incident-3');
  expect(element.querySelector('[data-review]')).not.toBeNull();
  act(() => root.unmount());
  element.remove();
  localStorage.clear();
});
