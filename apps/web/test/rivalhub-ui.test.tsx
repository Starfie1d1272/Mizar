// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(container.textContent).toContain('本机正在提供实时数据');
    expect(
      fetchMock.mock.calls.filter((call) =>
        toUrlString(call[0]).includes('/operator/rivalhub/source/claim'),
      ),
    ).toHaveLength(1);
  });
});
