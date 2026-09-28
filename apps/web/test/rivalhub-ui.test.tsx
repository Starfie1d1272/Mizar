// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RivalHubPreparationPanel } from '../src/operator/RivalHubPreparationPanel';
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

function parseJsonBody<T>(init?: RequestInit): T {
  if (typeof init?.body === 'string') {
    return JSON.parse(init.body) as T;
  }
  return {} as T;
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
  vi.restoreAllMocks();
});

describe('Preparation: RivalHubPreparationPanel', () => {
  it('renders browser pairing trigger when not paired, and polls to completion', async () => {
    let pairedState = false;
    let pollCount = 0;
    const openMock = vi.fn().mockReturnValue({ close: vi.fn(), location: { replace: vi.fn() } });
    vi.stubGlobal('open', openMock);

    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: pairedState,
            competitionId: pairedState ? 'comp-1' : null,
            displayName: pairedState ? '星宇' : null,
            activeMatchId: null,
            activeSourceMatchId: null,
            activeDeviceName: null,
          }),
        );
      }
      if (u.includes('/local/v1/rivalhub-schedule')) {
        return Promise.resolve(
          Response.json({
            competition: { name: '2026 NJU Rivals' },
            matches: [],
          }),
        );
      }
      if (u.includes('/operator/rivalhub/pairing/start')) {
        return Promise.resolve(
          Response.json({
            authorizeUrl: 'https://match.starfie1d.top/integrations/mizar/connect?pairingId=abc',
          }),
        );
      }
      if (u.includes('/operator/rivalhub/pairing/poll')) {
        pollCount++;
        if (pollCount === 1) {
          pairedState = true;
          return Promise.resolve(Response.json({ status: 'authorized' }));
        }
        return Promise.resolve(Response.json({ status: 'pending' }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root!.render(<RivalHubPreparationPanel mode="settings" />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('连接 RivalHub 赛事');
    expect(container.textContent).toContain('在 RivalHub 登录并确认授权，完成后会自动连接。');
    const inputs = container.querySelectorAll('input');
    expect(inputs.length).toBe(0);

    const buttons = container.querySelectorAll('button');
    const pairBtn = Array.from(buttons).find((b) => b.textContent?.includes('连接 RivalHub'))!;
    expect(pairBtn).toBeDefined();

    await act(async () => {
      pairBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/rivalhub/pairing/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/rivalhub/pairing/poll',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('RivalHub 已连接。');
    expect(container.textContent).toContain('星宇');
  });

  it('resumes polling when page is refreshed with pending pairing', async () => {
    let pollInvoked = false;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: false,
            competitionId: null,
            displayName: null,
            activeMatchId: null,
            activeSourceMatchId: null,
            activeDeviceName: null,
            pairing: 'pending',
          }),
        );
      }
      if (u.includes('/operator/rivalhub/pairing/poll')) {
        pollInvoked = true;
        return Promise.resolve(Response.json({ status: 'pending' }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root!.render(<RivalHubPreparationPanel mode="settings" />);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/rivalhub/pairing/poll',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(pollInvoked).toBe(true);
    expect(container.textContent).toContain('正在等待 RivalHub 授权…');
  });

  it('displays schedule, allows match selection, and confirms candidate to load match', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: true,
            competitionId: 'comp-1',
            displayName: '主舞台制播机',
            activeMatchId: null,
            activeSourceMatchId: null,
            activeDeviceName: null,
          }),
        );
      }
      if (u.includes('/local/v1/rivalhub-schedule')) {
        return Promise.resolve(
          Response.json({
            competition: { name: '2026 南京高校联赛' },
            matches: [
              {
                matchId: 'match-101',
                scheduledAt: '2026-10-01T10:00:00Z',
                entrantA: { name: '南京大学' },
                entrantB: { name: '东南大学' },
                format: 'bo3',
              },
            ],
          }),
        );
      }
      if (u.includes('/operator/rivalhub/select')) {
        const body = parseJsonBody<{ matchId: string }>(init);
        expect(body).toEqual({ matchId: 'match-101' });
        mockBpWorkspace = {
          workspace: {
            contextRevision: 'rev-ctx-1',
            pendingRivalhub: {
              competition: '2026 南京高校联赛',
              format: 'bo3',
              entrants: { a: { name: '南京大学' }, b: { name: '东南大学' } },
              revision: 'cand-rev-1',
            },
          },
          connected: true,
          loading: false,
        };
        return Promise.resolve(Response.json({ pending: true }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root!.render(<RivalHubPreparationPanel />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('2026 南京高校联赛');
    expect(container.textContent).toContain('主舞台制播机');
    expect(container.textContent).toContain('已连接');

    const select = container.querySelector('select')!;
    expect(select).not.toBeNull();
    expect(select.options.length).toBe(2);

    await act(async () => {
      select.value = 'match-101';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/rivalhub/select',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已取得比赛资料，请核对双方后确认加载。');

    await act(async () => {
      root!.render(<RivalHubPreparationPanel />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('待确认比赛候选');
    expect(container.textContent).toContain('南京大学 vs 东南大学');

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认加载比赛'),
    )!;
    expect(confirmBtn).not.toBeUndefined();

    await act(async () => {
      confirmBtn.click();
      await Promise.resolve();
    });

    expect(mockSwitchToRivalhubBp).toHaveBeenCalledWith('rev-ctx-1', 'cand-rev-1');
    expect(container.textContent).toContain(
      '在线比赛已加载。进入现场工作区后会检查实时数据源；无人占用时自动认领。',
    );
  });
});

describe('Live Workspace: RivalHubLiveSourcePanel', () => {
  it('does not display any pairing form, URL, code, or schedule selector', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          paired: true,
          displayName: '主舞台制播机',
          activeMatchId: 'match-101',
          activeSourceMatchId: 'match-101',
          activeDeviceName: null,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel
          action={async (fn) => void (await fn())}
          onMessage={() => {}}
          currentMatchTitle="南京大学 vs 东南大学"
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).not.toContain('赛事网站地址');
    expect(container.textContent).not.toContain('一次性连接码');
    expect(container.textContent).not.toContain('match-101');
    expect(container.textContent).not.toContain('查看近期赛程');

    expect(container.textContent).toContain('实时数据源');
    expect(container.textContent).toContain('本机正在提供实时数据');
    expect(container.textContent).toContain('停止作为数据源');
  });

  it('renders null when not paired or no active online match', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          paired: false,
          displayName: null,
          activeMatchId: null,
          activeSourceMatchId: null,
          activeDeviceName: null,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel action={async (fn) => void (await fn())} onMessage={() => {}} />,
      );
      await Promise.resolve();
    });

    expect(container.innerHTML).toBe('');
  });

  it('auto-claims when entering workspace with an unowned active match', async () => {
    let sourceMatchId: string | null = null;
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

    const onMessage = vi.fn();
    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel action={async (fn) => void (await fn())} onMessage={onMessage} />,
      );
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/rivalhub/source/claim',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('本机正在提供实时数据');
    expect(onMessage).toHaveBeenCalledWith('本机已成为本场实时数据源。');

    const claimCalls = fetchMock.mock.calls.filter((c) =>
      toUrlString(c[0]).includes('/operator/rivalhub/source/claim'),
    );
    expect(claimCalls.length).toBe(1);
  });

  it('recovers from first-round transient 409 failure and claims on subsequent check', async () => {
    let attempts = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: attempts > 1 ? 'match-101' : null,
            activeDeviceName: null,
          }),
        );
      }
      if (u.includes('/operator/rivalhub/source/claim')) {
        attempts++;
        if (attempts === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: '请先在工作区加载赛事比赛。' }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
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

    vi.useFakeTimers();

    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel action={async (fn) => void (await fn())} onMessage={() => {}} />,
      );
      await Promise.resolve();
    });

    expect(attempts).toBe(1);
    expect(container.textContent).toContain('当前暂无数据源');

    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    expect(attempts).toBe(2);
    expect(container.textContent).toContain('本机正在提供实时数据');

    vi.useRealTimers();
  });

  it('does not report manual claim success when another device wins the race', async () => {
    let claimAttempt = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: null,
            activeDeviceName: null,
          }),
        );
      }
      if (u.includes('/operator/rivalhub/source/claim')) {
        claimAttempt++;
        if (claimAttempt === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: '当前暂未准备好认领。' }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: null,
            activeDeviceName: '备用副机 B',
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const onMessage = vi.fn();
    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel action={async (fn) => void (await fn())} onMessage={onMessage} />,
      );
      await Promise.resolve();
    });

    const claimBtn = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('成为本场数据源'),
    );
    expect(claimBtn).not.toBeUndefined();

    await act(async () => {
      claimBtn!.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('当前由 备用副机 B 提供实时数据');
    expect(onMessage).toHaveBeenLastCalledWith('当前由 备用副机 B 提供实时数据。');
    expect(onMessage).not.toHaveBeenCalledWith('本机已成为本场实时数据源。');
  });

  it('discovers other active source, does not auto-takeover, and only takes over on explicit user action', async () => {
    let sourceMatchId: string | null = null;
    let activeDevice: string | null = '备用副机 B';

    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: sourceMatchId,
            activeDeviceName: activeDevice,
          }),
        );
      }
      if (u.includes('/operator/rivalhub/source/claim')) {
        const body = parseJsonBody<{ takeover?: boolean }>(init);
        if (body.takeover) {
          sourceMatchId = 'match-101';
          activeDevice = null;
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
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: 'match-101',
            activeSourceMatchId: null,
            activeDeviceName: '备用副机 B',
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

    expect(container.textContent).toContain('当前由 备用副机 B 提供实时数据');
    const takeoverBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('接管为本场数据源'),
    )!;
    expect(takeoverBtn).not.toBeUndefined();

    await act(async () => {
      takeoverBtn.click();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/operator/rivalhub/source/claim',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ takeover: true }),
      }),
    );
    expect(container.textContent).toContain('本机正在提供实时数据');
  });

  it('resets auto-claim state on match change', async () => {
    let currentMatch = 'match-101';
    const claimCalls: string[] = [];

    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = toUrlString(url);
      if (u.includes('/local/v1/rivalhub-connection')) {
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: currentMatch,
            activeSourceMatchId: null,
            activeDeviceName: null,
          }),
        );
      }
      if (u.includes('/operator/rivalhub/source/claim')) {
        claimCalls.push(currentMatch);
        return Promise.resolve(
          Response.json({
            paired: true,
            displayName: '主舞台制播机',
            activeMatchId: currentMatch,
            activeSourceMatchId: currentMatch,
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

    expect(claimCalls).toEqual(['match-101']);

    currentMatch = 'match-102';

    await act(async () => {
      root!.render(
        <RivalHubLiveSourcePanel action={async (fn) => void (await fn())} onMessage={() => {}} />,
      );
      await Promise.resolve();
    });

    expect(claimCalls).toEqual(['match-101', 'match-102']);
  });

  it('supports explicit release and does not auto-re-claim after release', async () => {
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
            activeMatchId: 'match-101',
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

    expect(container.textContent).toContain('本机正在提供实时数据');
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

    const claimCalls = fetchMock.mock.calls.filter((c) =>
      toUrlString(c[0]).includes('/operator/rivalhub/source/claim'),
    );
    expect(claimCalls.length).toBe(0);
  });
});
