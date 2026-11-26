// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalChannelClient } from './use-local-channel-client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  protocol = 'mizar.local.v1';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly subprotocol: string,
  ) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  send() {}
}

describe('useLocalChannelClient', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    await act(async () => {
      vi.runAllTimers();
    });
    container?.remove();
    container = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function Probe({ enabled }: { enabled: boolean }) {
    useLocalChannelClient('program', enabled);
    return null;
  }

  it('connects only when enabled, disposes on disable, and creates a fresh connection on re-enable', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe enabled={false} />);
    });
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(async () => {
      root?.render(<Probe enabled />);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    const first = FakeWebSocket.instances[0]!;
    expect(first.closed).toBe(false);

    await act(async () => {
      root?.render(<Probe enabled={false} />);
    });
    await act(async () => {
      vi.runAllTimers();
    });
    expect(first.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      root?.render(<Probe enabled />);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.closed).toBe(false);
  });

  it('survives React StrictMode double-invoke without duplicate or disposed sockets', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <StrictMode>
          <Probe enabled />
        </StrictMode>,
      );
      vi.runAllTimers();
    });

    const activeSockets = FakeWebSocket.instances.filter((socket) => !socket.closed);
    expect(activeSockets).toHaveLength(1);
  });
});
