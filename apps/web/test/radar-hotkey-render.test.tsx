// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { radarSnapshotSchema } from '@mizar/protocol/radar';

import fixtures from '../src/program/fixtures/generated/real-radar-fixtures.generated.json';
import { Radar } from '../src/program/widgets/radar/Radar';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Radar observer hotkey rendering', () => {
  it('draws the hotkey label for the raw observer slot', () => {
    const snapshot = radarSnapshotSchema.parse(
      fixtures.fixtures['dense-utility'].samples[0]!.snapshot,
    );
    const player = snapshot.payload.players[0]!;
    snapshot.payload.mapName = 'de_mirage';
    snapshot.payload.observedPlayerSourceId = null;
    snapshot.payload.grenades = [];
    snapshot.payload.bomb = null;
    snapshot.payload.players = [
      {
        ...player,
        forward: { x: 1, y: 0, z: 0 },
        lifeState: 'alive',
        observerSlot: 9,
        position: { x: -1000, y: 0, z: 0 },
      },
    ];

    const fillText = vi.fn();
    const noOp = vi.fn();
    const context = new Proxy(
      { fillText },
      {
        get: (target, property) => (property === 'fillText' ? target.fillText : noOp),
        set: (target, property, value) => Reflect.set(target, property, value),
      },
    ) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Radar snapshot={snapshot} />));
    act(() => frames[0]!(0));

    expect(fillText).toHaveBeenCalledWith('0', expect.any(Number), expect.any(Number));
  });
});
