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
  isReviewWindow: () => window.location.pathname === '/workspace/review',
  closeReviewWindow: () => Promise.resolve(),
}));
vi.mock('../src/operator/RivalHubSyncControls', () => ({ RivalHubSyncControls: () => null }));
vi.mock('../src/debug/SupportExport', () => ({ SupportExport: () => null }));
import { SyncHealthAlert } from '../src/workspace/SyncHealthAlert';
import { LiveRosterAlert } from '../src/workspace/LiveRosterAlert';
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
    (b) => b.textContent === '本场不再弹出提示和警告',
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

it('keeps a manually opened roster review visible while automatic alerts are silenced', () => {
  localStorage.setItem(SILENCED_MATCH_KEY, 'match-a');
  window.history.replaceState(null, '', '/workspace/review?kind=roster');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  act(() =>
    root.render(
      <LiveRosterAlert
        matchId="match-a"
        recovered={false}
        onReview={() => {}}
        error={null}
        alert={{
          key: 'incident',
          syncStatus: '需要核对',
          observed: [{ key: 'one', displayName: '选手一', avatarUrl: null }],
          absent: [],
        }}
      />,
    ),
  );
  expect(element.querySelector('[data-review]')?.textContent).toContain('选手一');
  act(() => root.unmount());
  element.remove();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
