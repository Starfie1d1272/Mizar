// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RivalHubMatchLibrary, type WebsiteSchedule } from '../src/operator/RivalHubMatchLibrary';
import { sortWebsiteMatches } from '../src/operator/website-schedule-order';
import { RivalHubLiveSourcePanel } from '../src/workspace/RivalHubLiveSourcePanel';

let mockBpWorkspace: {
  workspace: {
    contextRevision: string;
    pendingRivalhub: {
      competition: string;
      format: string;
      entrants: { a: { name: string }; b: { name: string } };
      revision: string;
    } | null;
  } | null;
  connected: boolean;
  loading: boolean;
} = {
  workspace: null,
  connected: true,
  loading: false,
};

const mockSwitchToRivalhubBp = vi
  .fn<(rev1: string, rev2: string) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('../src/bp/client', () => ({
  useBpWorkspace: () => mockBpWorkspace,
  switchToRivalhubBp: (rev1: string, rev2: string) => mockSwitchToRivalhubBp(rev1, rev2),
}));

let root: Root | undefined;
let container: HTMLDivElement;

function toUrlString(url: string | URL | Request): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockBpWorkspace = {
    workspace: null,
    connected: true,
    loading: false,
  };
  mockSwitchToRivalhubBp.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Live Workspace: RivalHubLiveSourcePanel', () => {
  it('supports explicit release and does not auto-re-claim after release', async () => {
    vi.useFakeTimers();
    let sourceMatchId: string | null = 'match-101';
    let releaseCalled = false;

    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: sourceMatchId,
            activeDeviceName: null,
            syncHealth: sourceMatchId
              ? { status: 'healthy', reason: null, incidentId: null, deviceName: null }
              : undefined,
          }),
        );
      }
      if (u.includes('/operator/rivalhub/source/release')) {
        releaseCalled = true;
        sourceMatchId = null;
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeSourceMatchId: null,
            activeDeviceName: null,
          }),
        );
      }
      if (u.includes('/operator/rivalhub/source/claim')) {
        sourceMatchId = 'match-101';
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: 'match-101',
            activeDeviceName: null,
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel action={async (fn) => void (await fn())} onMessage={() => {}} />,
      );
      await Promise.resolve();
    });

    expect(container.textContent?.match(/网站正在接收本场数据/g)).toHaveLength(1);
    const releaseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('停止作为数据源'),
    )!;
    expect(releaseBtn).not.toBeUndefined();

    await act(async () => {
      releaseBtn.click();
      await Promise.resolve();
    });

    expect(releaseCalled).toBe(true);
    expect(container.textContent).toContain('当前暂无数据源');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(container.textContent).toContain('当前暂无数据源');

    const claimCalls = fetchMock.mock.calls.filter((c) =>
      toUrlString(c[0]).includes('/operator/rivalhub/source/claim'),
    );
    expect(claimCalls.length).toBe(0);

    const resumeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '成为本场数据源',
    )!;
    await act(async () => {
      resumeButton.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('网站接收待确认');
    expect(
      fetchMock.mock.calls.filter((call) =>
        toUrlString(call[0]).includes('/operator/rivalhub/source/claim'),
      ),
    ).toHaveLength(1);
  });
});

describe('website match library order', () => {
  it('orders website states and dates deterministically without changing the source array', () => {
    const matches = Object.freeze(
      [
        {
          matchId: 'finished-old',
          status: 'finished',
          scheduledAt: '2020-01-01',
          completedAt: '2020-01-02',
        },
        { matchId: 'unscheduled', status: 'scheduled', scheduledAt: null },
        { matchId: 'scheduled-b', status: 'scheduled', scheduledAt: '2026-11-01' },
        { matchId: 'cancelled', status: 'cancelled', scheduledAt: '2026-11-03' },
        { matchId: 'live', status: 'in_progress', scheduledAt: null },
        { matchId: 'legacy', scheduledAt: '2020-01-01' },
        { matchId: 'scheduled-a', status: 'scheduled', scheduledAt: '2026-11-01' },
        {
          matchId: 'finished-new',
          status: 'finished',
          scheduledAt: '2019-01-01',
          completedAt: '2026-11-04',
        },
        { matchId: 'undated-ended', status: 'finished', scheduledAt: null },
        { matchId: 'invalid', status: 'scheduled', scheduledAt: 'invalid' },
        {
          matchId: 'fallback',
          status: 'cancelled',
          scheduledAt: '2026-11-02',
          completedAt: 'invalid',
        },
      ].map((match) => Object.freeze(match)),
    );
    const original = [...matches];
    const expected = [
      'live',
      'legacy',
      'scheduled-a',
      'scheduled-b',
      'invalid',
      'unscheduled',
      'finished-new',
      'cancelled',
      'fallback',
      'finished-old',
      'undated-ended',
    ];
    expect(sortWebsiteMatches(matches).map((match) => match.matchId)).toEqual(expected);
    expect(sortWebsiteMatches([...matches].reverse()).map((match) => match.matchId)).toEqual(
      expected,
    );
    expect(matches).toEqual(original);
    expect(sortWebsiteMatches([])).toEqual([]);
  });

  it('defaults to the sorted first match and preserves an explicit choice through refresh', () => {
    const row = (matchId: string, status: 'scheduled' | 'in_progress' | 'finished') => ({
      matchId,
      status,
      scheduledAt: null,
      format: 'bo3',
      entrantA: { name: matchId },
      entrantB: { name: 'opponent' },
    });
    const onSelect = vi.fn();
    const render = (matches: WebsiteSchedule['matches']) =>
      act(() =>
        root?.render(
          <RivalHubMatchLibrary
            schedule={{ competition: { name: 'test' }, matches }}
            selecting={false}
            onSelect={onSelect}
            activeMatchId="b"
            refreshing={false}
            onRefresh={() => {}}
          />,
        ),
      );
    render([row('b', 'scheduled'), row('a', 'in_progress')]);
    expect(container.querySelector('h2')?.textContent).toBe('a vs opponent');
    const choice = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('b vs opponent'),
    )!;
    act(() => choice.click());
    render([row('a', 'in_progress'), row('b', 'finished')]);
    expect(container.querySelector('h2')?.textContent).toBe('b vs opponent');
    expect(container.textContent).toContain('前往本场准备');
    expect(onSelect).not.toHaveBeenCalled();
    render([row('c', 'scheduled'), row('a', 'in_progress')]);
    expect(container.querySelector('h2')?.textContent).toBe('a vs opponent');
  });
});
