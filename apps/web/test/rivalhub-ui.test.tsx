// @vitest-environment jsdom
import { act } from 'react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

it('pins only the viewer assigned unfinished matches, independently of display names', () => {
  const rows = [
    { matchId: 'other-live', status: 'in_progress', scheduledAt: null, assignedToViewer: false },
    {
      matchId: 'mine-upcoming',
      status: 'scheduled',
      scheduledAt: '2026-11-01',
      assignedToViewer: true,
    },
    { matchId: 'mine-ended', status: 'finished', scheduledAt: null, assignedToViewer: true },
    { matchId: 'mine-live', status: 'in_progress', scheduledAt: null, assignedToViewer: true },
    { matchId: 'unknown', status: 'scheduled', scheduledAt: null },
  ];
  expect(sortWebsiteMatches(rows).map((row) => row.matchId)).toEqual([
    'mine-live',
    'mine-upcoming',
    'other-live',
    'unknown',
    'mine-ended',
  ]);
  // A server correction/removal immediately returns the match to its normal group.
  expect(
    sortWebsiteMatches(rows.map((row) => ({ ...row, assignedToViewer: false }))).map(
      (row) => row.matchId,
    ),
  ).toEqual(['mine-live', 'other-live', 'mine-upcoming', 'unknown', 'mine-ended']);
});

it('reads only visible details, stops hidden/unmounted timers, and ignores late A after switching to B', async () => {
  vi.useFakeTimers();
  const flush = async (action: () => void) => {
    await act(async () => {
      action();
      await Promise.resolve();
    });
  };
  let resolveA: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((url: string | URL | Request) => {
    if (toUrlString(url).includes('/a?'))
      return new Promise<Response>((resolve) => {
        resolveA = resolve;
      });
    return Promise.resolve(Response.json({ entry: null, error: 'B 缺少离线资料' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const schedule: WebsiteSchedule = {
    competition: { name: 'fixture' },
    viewer: { userId: 'user-1', displayName: '同名' },
    matches: ['a', 'b'].map((matchId) => ({
      matchId,
      scheduledAt: null,
      format: 'bo3',
      entrantA: { name: matchId },
      entrantB: { name: '同名' },
      assignedToViewer: matchId === 'b',
    })),
  };
  await flush(() =>
    root!.render(
      <details>
        <summary>比赛库</summary>
        <RivalHubMatchLibrary
          schedule={schedule}
          selecting={false}
          activeMatchId={null}
          refreshing={false}
          onRefresh={() => {}}
          onSelect={() => {}}
        />
      </details>,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(0);
  const details = container.querySelector('details')!;
  await flush(() => {
    details.open = true;
    details.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(toUrlString(fetchMock.mock.calls[0]![0])).toContain('/b?fresh=1');
  expect(container.textContent).toContain('授权账号：同名');
  expect(container.textContent).toContain('我认领的');
  const choose = (name: string) =>
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(`${name} vs 同名`),
    )!;
  await flush(() => choose('a').click());
  await flush(() => choose('b').click());
  await flush(() => resolveA?.(Response.json({ entry: null, error: 'late A' })));
  expect(container.textContent).not.toContain('late A');
  expect(container.textContent).toContain('B 缺少离线资料');
  const before = fetchMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600_000);
  });
  expect(fetchMock.mock.calls.length - before).toBe(10);
  await flush(() => {
    details.open = false;
    details.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
  const hidden = fetchMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(hidden);
  await flush(() => root!.render(null));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(hidden);
});

it('invalidates same-match detail fallback immediately across scopes, including late success and new-scope failure', async () => {
  const { parseMatchDocumentV1 } = await import('@mizar/protocol/context');
  const input: unknown = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/protocol/test/fixtures/match-document-v1.json'),
      'utf8',
    ),
  );
  const document = parseMatchDocumentV1(input);
  const old = {
    ...document,
    entrants: { ...document.entrants, a: { ...document.entrants.a, name: '旧授权独有队名' } },
  };
  const entry = {
    document: old,
    checkedAt: '2026-09-16T12:00:00Z',
    updatedAt: '2026-09-16T12:00:00Z',
  };
  const responses: ((response: Response) => void)[] = [];
  let first = true;
  const fetchMock = vi.fn(() => {
    if (first) {
      first = false;
      return Promise.resolve(Response.json({ entry, error: null }));
    }
    return new Promise<Response>((resolve) => responses.push(resolve));
  });
  vi.stubGlobal('fetch', fetchMock);
  const render = async (scopeId: string) => {
    await act(async () => {
      root!.render(
        <RivalHubMatchLibrary
          schedule={{
            competition: { name: 'fixture' },
            matches: [
              {
                matchId: document.matchId,
                scheduledAt: null,
                format: 'bo3',
                entrantA: { name: '摘要甲' },
                entrantB: { name: '摘要乙' },
              },
            ],
            library: { scopeId, entries: {}, syncedAt: null, refreshing: false, error: null },
          }}
          selecting={false}
          activeMatchId={null}
          refreshing={false}
          onSelect={() => {}}
          onRefresh={() => {}}
        />,
      );
      await Promise.resolve();
    });
  };
  await render('scope-a');
  expect(container.textContent).toContain('旧授权独有队名');
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '刷新比赛')!
      .click();
    await Promise.resolve();
  });
  await render('scope-b');
  expect(container.textContent).not.toContain('旧授权独有队名');
  await act(async () => {
    responses[0]!(Response.json({ entry, error: null }));
    responses[1]!(new Response(null, { status: 503 }));
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain('旧授权独有队名');
  expect(container.textContent).toContain('完整资料暂时无法获取');
});

it('renders the real server viewer and assignment flags and degrades to unknown with the old provider shape', async () => {
  const read = async (name: string) =>
    JSON.parse(
      await readFile(
        resolve(
          process.cwd(),
          `packages/rivalhub/test/fixtures/server-schedule-2026-10-26/${name}`,
        ),
        'utf8',
      ),
    ) as WebsiteSchedule;
  const modern = await read('schedule-new-http.json');
  const legacy = await read('schedule-old-shape.json');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ entry: null, error: 'fixture no detail' }))),
  );
  const render = async (schedule: WebsiteSchedule) => {
    await act(async () => {
      root!.render(
        <RivalHubMatchLibrary
          schedule={schedule}
          selecting={false}
          activeMatchId={null}
          refreshing={false}
          onRefresh={() => {}}
          onSelect={() => {}}
        />,
      );
      await Promise.resolve();
    });
  };
  await render(modern);
  expect(container.textContent).toContain('授权账号：合成解说');
  expect(container.querySelectorAll('.library-list button')).toHaveLength(3);
  expect(
    [...container.querySelectorAll('.library-list button')].filter((button) =>
      button.textContent?.includes('我认领的'),
    ),
  ).toHaveLength(1);
  await render(legacy);
  expect(container.textContent).not.toContain('授权账号：');
  expect(container.textContent).not.toContain('我认领的');
  expect(container.querySelectorAll('.library-list button')).toHaveLength(3);
});

describe('website library one-action load', () => {
  async function renderPanel(load: () => Promise<Response>) {
    const { RivalHubPreparationPanel } = await import('../src/operator/RivalHubPreparationPanel');
    const onLoaded = vi.fn();
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const path = toUrlString(url);
      if (path === '/operator/rivalhub/select') return load();
      if (path === '/local/v1/rivalhub-connection')
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: 'test',
            activeMatchId: null,
            activeSourceMatchId: null,
            activeDeviceName: null,
          }),
        );
      if (path === '/local/v1/rivalhub-schedule')
        return Promise.resolve(
          Response.json({
            competition: { name: '赛事' },
            matches: [
              {
                matchId: 'requested-match',
                scheduledAt: null,
                entrantA: { name: '甲' },
                entrantB: { name: '乙' },
                format: 'bo3',
              },
            ],
          }),
        );
      return Promise.resolve(Response.json({ entry: null, error: null }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(() => {
      root!.render(<RivalHubPreparationPanel onLoaded={onLoaded} />);
      return Promise.resolve();
    });
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '核对并载入本场',
    )!;
    expect(button).toBeDefined();
    return { onLoaded, fetchMock, button };
  }

  it('commits with the original button and navigates only after confirmed load', async () => {
    let complete!: (value: Response) => void;
    const { button, fetchMock, onLoaded } = await renderPanel(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await act(() => {
      button.click();
      button.click();
      return Promise.resolve();
    });
    expect(onLoaded).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter((c) => toUrlString(c[0]) === '/operator/rivalhub/select'),
    ).toHaveLength(1);
    expect(button.disabled).toBe(true);
    const request = vi
      .mocked(fetch)
      .mock.calls.find((c) => toUrlString(c[0]) === '/operator/rivalhub/select');
    const requestBody = request?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected JSON request body');
    expect(JSON.parse(requestBody)).toEqual({
      matchId: 'requested-match',
      activate: true,
    });
    await act(() => {
      complete(Response.json({ loaded: true, matchId: 'requested-match' }));
      return Promise.resolve();
    });
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('确认加载比赛');
  });

  it.each([
    [200, { pending: true }],
    [200, { loaded: true, matchId: 'different-match' }],
    [409, { message: '本场已变化，未载入' }],
    [500, { message: '保存失败，原本场保留' }],
  ])(
    'does not treat unconfirmed response %i as loaded and puts the error beside the action',
    async (status, payload) => {
      const { button, onLoaded } = await renderPanel(() =>
        Promise.resolve(Response.json(payload, { status })),
      );
      await act(() => {
        button.click();
        return Promise.resolve();
      });
      expect(onLoaded).not.toHaveBeenCalled();
      expect(container.querySelector('.library-detail-actions [role="alert"]')).not.toBeNull();
      expect(button.disabled).toBe(false);
    },
  );
});
