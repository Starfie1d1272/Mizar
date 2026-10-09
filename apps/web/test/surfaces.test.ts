// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebugPage, surfaceForPath } from '../src/App';
import { parseDebugRuntimeResponse, type DebugRuntimeResponse } from '../src/debug/runtime';
import { parseBrowserHostDiagnostics } from '../src/debug/host-diagnostics';

const DEBUG_RESPONSE: DebugRuntimeResponse = {
  producerInstanceId: 'web-test-producer',
  sourceGeneration: 0,
  freshness: 'fresh',
  raw: { current: { sequence: 4 } },
  normalized: { current: { receive: { sequence: 4 } } },
  runtime: {
    current: { runtimeSeq: 2, map: { epoch: 1, name: 'de_ancient' } },
    lastDisposition: { kind: 'accepted', reason: 'contiguous' },
  },
  recentTransitions: [],
  latestGsiDiagnostics: null,
  recentRuntimeDiagnostics: [],
  recorderHealth: { state: 'recording' },
  deliveryHealth: [],
};

const AWAITING_DEBUG_RESPONSE: DebugRuntimeResponse = {
  ...DEBUG_RESPONSE,
  freshness: 'awaiting',
  raw: { current: null },
  normalized: { current: null },
  runtime: { current: {}, lastDisposition: null },
  recorderHealth: { state: 'recording' },
};

let root: Root | undefined;

function mountDebugPage(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(createElement(DebugPage));
  return container;
}

function unmountDebugPage(): void {
  if (root === undefined) return;
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  unmountDebugPage();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('web surface shell', () => {
  it.each([
    ['/program', 'program'],
    ['/operator', 'operator'],
    ['/debug', 'debug'],
  ] as const)('maps %s to the %s surface', (pathname, expectedId) => {
    expect(surfaceForPath(pathname)?.id).toBe(expectedId);
  });

  it('routes root to operator and never treats unknown paths as Program', () => {
    expect(surfaceForPath('/')?.id).toBe('operator');
    expect(surfaceForPath('/operator/hud')?.id).toBe('hud');
    expect(surfaceForPath('/missing')).toBeUndefined();
  });

  it('accepts the bounded awaiting debug shape', () => {
    expect(
      parseDebugRuntimeResponse({
        producerInstanceId: 'producer-1',
        sourceGeneration: 0,
        freshness: 'awaiting',
        raw: { current: null },
        normalized: { current: null },
        runtime: { current: {}, lastDisposition: null },
        recentTransitions: [],
        latestGsiDiagnostics: null,
        recentRuntimeDiagnostics: [],
        recorderHealth: { state: 'recording' },
        deliveryHealth: [],
      }),
    ).toMatchObject({ freshness: 'awaiting', sourceGeneration: 0 });
  });

  it('rejects a response missing required debug fields instead of guessing state', () => {
    expect(parseDebugRuntimeResponse({ freshness: 'fresh' })).toBeUndefined();
  });

  it('accepts bounded and sanitized browser host diagnostics', () => {
    expect(
      parseBrowserHostDiagnostics({
        active: {
          obs: 1,
          browser: 2,
          unknown: 0,
          byChannel: { program: 1, operator: 2 },
          byHostChannel: {
            obs: { program: 1, operator: 0 },
            browser: { program: 0, operator: 2 },
            unknown: { program: 0, operator: 0 },
          },
          obsVersions: ['32.0.2'],
        },
        totals: {
          connected: 5,
          disconnected: 2,
          connectionLimitRejected: 0,
          slowConsumerTerminated: 1,
          snapshotOversize: 0,
          heartbeatTerminated: 0,
          sendFailed: 0,
        },
        recentEvents: [
          {
            sequence: 7,
            at: '2026-09-26T00:00:00.000Z',
            action: 'connected',
            host: 'obs',
            channel: 'program',
            obsVersion: '32.0.2',
          },
        ],
      }),
    ).toMatchObject({
      active: { obs: 1, browser: 2, obsVersions: ['32.0.2'] },
      totals: { connected: 5, slowConsumerTerminated: 1 },
      recentEvents: [{ host: 'obs', channel: 'program' }],
    });
  });

  it('renders the loading state while the first Companion request is pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );

    let container: HTMLDivElement;
    act(() => {
      container = mountDebugPage();
    });

    expect(container!.textContent).toContain('正在连接本地制播服务');
    expect(container!.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('renders awaiting telemetry returned by Companion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(AWAITING_DEBUG_RESPONSE),
        }),
      ),
    );

    let container: HTMLDivElement;
    await act(async () => {
      container = mountDebugPage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('等待 GSI 数据');
    expect(container!.textContent).toContain('暂无证据');
    expect(container!.textContent).toContain('未建立');
  });

  it('renders ready debug evidence returned by Companion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(DEBUG_RESPONSE),
        }),
      ),
    );

    let container: HTMLDivElement;
    await act(async () => {
      container = mountDebugPage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('正常');
    expect(container!.textContent).toContain('de_ancient');
    expect(container!.querySelector('details')?.open).toBe(false);
    expect(container!.textContent).toContain('高级技术信息');
    expect(container!.textContent).toContain('已接收原始数据');
    expect(container!.textContent).toContain('标准化观测');
    expect(container!.textContent).toContain('当前运行状态');
  });

  it('renders a Chinese degraded error state without leaking raw network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    let container: HTMLDivElement;
    await act(async () => {
      container = mountDebugPage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      '本地制播服务暂不可用',
    );
    expect(container!.textContent).toContain('无法连接本地制播服务');
    expect(container!.textContent).not.toContain('network down');
  });
});
