// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RadarView, fromPublicRadar, type RadarViewFrame } from '@mizar-hud/radar-view';
import { parseLiveSnapshotV1 } from '@mizar/protocol/output';
import { readFileSync } from 'node:fs';

const fixture: unknown = JSON.parse(
  readFileSync('packages/protocol/test/fixtures/live-snapshot-v1.radar.json', 'utf8'),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps drawing new samples after a projectile disappears when a RAF timestamp predates the input callback', async () => {
  const live = parseLiveSnapshotV1(fixture);
  const base = fromPublicRadar(live.radar, {
    boundary: 'test:match:generation:map',
    sequence: 1,
    current: true,
    bomb: live.bomb,
  })!;
  const position = base.payload.players.find((player) => player.position)?.position;
  expect(position).toBeTruthy();
  let snapshot: RadarViewFrame = {
    ...base,
    payload: {
      ...base.payload,
      grenades: [
        {
          sourceEntityId: 'synthetic-flash',
          kind: 'flashbang',
          ownerSourceId: null,
          position: position!,
          lifetimeSeconds: 1,
          effectTimeSeconds: null,
          moving: true,
          flames: [],
        },
      ],
    },
  };
  let notify = () => {};
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  let clock = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const values: Record<string, unknown> = { canvas: this };
    return new Proxy(values, {
      get(target, key: string) {
        if (key in target) return target[key];
        if (key === 'arc')
          return (_x: number, _y: number, radius: number) => {
            if (radius < 0) throw new DOMException('negative arc radius', 'IndexSizeError');
          };
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'createLinearGradient' || key === 'createRadialGradient')
          return () => ({ addColorStop: () => {} });
        return () => {};
      },
    }) as unknown as CanvasRenderingContext2D;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {};
    },
  };
  const draw = (timestamp: number) => {
    const entry = callbacks.entries().next().value;
    expect(entry).toBeDefined();
    callbacks.delete(entry![0]);
    entry![1](timestamp);
  };
  try {
    await act(async () => {
      root.render(<RadarView client={client} assetBaseUrl="/radar-assets" />);
      await Promise.resolve();
    });
    draw(100);
    // Browser RAF timestamps may predate performance.now() in later callbacks.
    clock = 500;
    snapshot = { ...snapshot, sequence: 2, payload: { ...snapshot.payload, grenades: [] } };
    notify();
    expect(() => draw(180)).not.toThrow();
    clock = 550;
    snapshot = { ...snapshot, sequence: 3 };
    notify();
    draw(550);
    expect(host.querySelector('canvas')?.dataset.radarSampleSequence).toBe('3');
    expect(callbacks.size).toBe(1);
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
  }
});
