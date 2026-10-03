// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RadarView,
  fromPublicRadar,
  type RadarViewFrame,
  type RadarViewSource,
} from '@mizar/radar-view';
import { parseLiveSnapshotV1 } from '@mizar/protocol/output';
import { readFileSync } from 'node:fs';
// Read the shared wire corpus as data, not a cross-package source module.
const fixture: unknown = JSON.parse(
  readFileSync('packages/protocol/test/fixtures/live-snapshot-v1.radar.json', 'utf8'),
);

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const noOp = vi.fn();
  const context = new Proxy({}, { get: () => noOp, set: () => true }) as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  let callback: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    callback = cb;
    return 1;
  });
  const cancel = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancel);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return { step: (now: number) => act(() => callback(now)), cancel };
}
function frame(sequence = 1, x = 0.5): RadarViewFrame {
  const live = parseLiveSnapshotV1(fixture);
  const input = fromPublicRadar(live.radar, {
    boundary: 'current-public-match',
    current: true,
    sequence,
  })!;
  const player = input.payload.players[0]!;
  return {
    ...input,
    payload: {
      ...input.payload,
      observedPlayerSourceId: player.sourcePlayerId,
      players: [{ ...player, lifeState: 'alive', position: { x, y: 0.5, layer: 'upper' } }],
      grenades: [],
    },
  };
}
const canvas = () => container.querySelector('canvas')!;

describe('shared radar surface lifecycle', () => {
  it('mounts without a baseline, renders recovery, freezes stale motion and clears unavailable', () => {
    const { step } = setup();
    act(() => root!.render(<RadarView snapshot={null} assetBaseUrl="/vendor/radar" />));
    step(0);
    expect(canvas().dataset.radarState).toBe('unavailable');
    act(() => root!.render(<RadarView snapshot={frame()} assetBaseUrl="/vendor/radar" />));
    step(100);
    expect(canvas().dataset.radarPlayers).toBe('1');
    act(() => root!.render(<RadarView snapshot={frame(2, 0.52)} assetBaseUrl="/vendor/radar" />));
    step(600);
    step(700);
    act(() =>
      root!.render(<RadarView snapshot={frame(2, 0.52)} paused assetBaseUrl="/vendor/radar" />),
    );
    step(750);
    const motion = canvas().dataset.radarObservedMotion;
    step(5000);
    expect(canvas().dataset.radarObservedMotion).toBe(motion);
    act(() => root!.render(<RadarView snapshot={null} paused assetBaseUrl="/vendor/radar" />));
    step(5100);
    expect(canvas().dataset.radarPlayers).toBe('0');
    act(() =>
      root!.render(
        <RadarView
          snapshot={frame(1, 0.2)}
          presentationRevision={1}
          assetBaseUrl="/vendor/radar"
        />,
      ),
    );
    step(5200);
    expect(canvas().dataset.radarState).toBe('live');
    expect(canvas().dataset.radarObservedMotion?.split(',')[4]).toBe('0.200000');
  });

  it('clears a changed match or explicit reset even while the host is stale', () => {
    const { step } = setup();
    act(() => root!.render(<RadarView snapshot={frame()} assetBaseUrl="/radar" />));
    step(0);
    act(() =>
      root!.render(
        <RadarView
          snapshot={{ ...frame(), boundary: 'different-match' }}
          paused
          assetBaseUrl="/radar"
        />,
      ),
    );
    step(100);
    expect(canvas().dataset.radarPlayers).toBe('0');
    act(() => root!.render(<RadarView snapshot={frame()} assetBaseUrl="/radar" />));
    step(200);
    act(() =>
      root!.render(
        <RadarView snapshot={frame()} paused presentationRevision={1} assetBaseUrl="/radar" />,
      ),
    );
    step(300);
    expect(canvas().dataset.radarPlayers).toBe('0');
  });

  it('uses reduced motion and cleans up subscriptions and animation frames', () => {
    const { step, cancel } = setup();
    let current: RadarViewFrame | null = frame();
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const source: RadarViewSource = {
      getSnapshot: () => current,
      subscribe: (cb) => {
        listener = cb;
        return unsubscribe;
      },
    };
    act(() =>
      root!.render(
        <RadarView client={source} reducedMotion assetBaseUrl="https://cdn.example.test/radar" />,
      ),
    );
    step(100);
    current = frame(2, 0.52);
    act(() => listener!());
    step(600);
    expect(canvas().dataset.radarObservedMotion?.split(',')[4]).toBe('0.520000');
    current = null;
    act(() => listener!());
    step(700);
    expect(canvas().dataset.radarState).toBe('unavailable');
    act(() => root!.unmount());
    root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalled();
  });
});
