// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadarPayload, RadarSnapshot } from '@mizar/protocol/radar';
import { LOCAL_PROTOCOL_VERSION, RADAR_SCHEMA_VERSION } from '@mizar/protocol/version';
import { LocalChannelStore } from '../src/realtime/local-channel-store';
import {
  useRadarAvailability,
  type RadarAvailabilitySource,
} from '../src/workspace/use-radar-availability';

const resets = {
  liveSessionChanged: false,
  programSourceGenerationChanged: false,
  mapEpochChanged: false,
};
function frame(sequence: number, payload: Partial<RadarPayload> = {}): RadarSnapshot {
  return {
    type: 'snapshot',
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    channel: 'radar',
    schemaVersion: RADAR_SCHEMA_VERSION,
    channelSeq: sequence,
    cursor: {
      producerInstanceId: 'availability-test',
      liveSessionId: null,
      runtimeSeq: sequence,
      programSourceGeneration: 1,
      programReceiveSequence: sequence,
      mapEpoch: 1,
    },
    payload: {
      telemetryFreshness: 'fresh',
      identityState: 'matched',
      mapName: 'de_inferno',
      observedPlayerSourceId: null,
      coverage: { allPlayers: 'present', bomb: 'absent', grenades: 'absent' },
      players: [],
      bomb: null,
      grenades: [],
      ...payload,
    },
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});
function setup(initial: RadarAvailabilitySource) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const rendered = vi.fn();
  function Probe({ source }: { readonly source: RadarAvailabilitySource }) {
    const available = useRadarAvailability(source);
    rendered(available);
    return <span>{String(available)}</span>;
  }
  const render = (source: RadarAvailabilitySource) =>
    act(() => root!.render(<Probe source={source} />));
  render(initial);
  return { rendered, render };
}

describe('workspace radar availability subscription', () => {
  it('does not rerender for live sample-only changes and retains imperative delivery', () => {
    const store = new LocalChannelStore<RadarSnapshot>();
    const { rendered } = setup(store);
    const delivered: number[] = [];
    const unsubscribe = store.subscribe(() =>
      delivered.push(store.getSnapshot().current!.channelSeq),
    );
    act(() => store.accept(frame(1), resets));
    expect(rendered).toHaveBeenCalledTimes(2);
    for (let sequence = 2; sequence <= 101; sequence += 1) {
      act(() => store.accept(frame(sequence), resets));
    }
    expect(rendered).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
    expect(container!.textContent).toBe('true');
    unsubscribe();
  });

  it('reacts immediately to stale, mismatch, unsupported map and recovery', () => {
    const store = new LocalChannelStore<RadarSnapshot>();
    const { rendered } = setup(store);
    act(() => store.accept(frame(1), resets));
    act(() => store.accept(frame(2, { telemetryFreshness: 'stale' }), resets));
    expect(container!.textContent).toBe('false');
    act(() => store.accept(frame(3), resets));
    act(() => store.accept(frame(4, { identityState: 'mismatch' }), resets));
    expect(container!.textContent).toBe('false');
    act(() => store.accept(frame(5, { identityState: 'unbound' }), resets));
    expect(container!.textContent).toBe('true');
    act(() => store.accept(frame(6, { mapName: 'de_not_supported' }), resets));
    expect(container!.textContent).toBe('false');
    act(() => store.accept(frame(7, { mapName: 'de_nuke' }), resets));
    expect(container!.textContent).toBe('true');
    const renders = rendered.mock.calls.length;
    act(() =>
      store.accept(frame(8, { mapName: 'de_inferno' }), { ...resets, mapEpochChanged: true }),
    );
    expect(rendered).toHaveBeenCalledTimes(renders);
    expect(store.getSnapshot().current?.payload.mapName).toBe('de_inferno');
  });

  it('does not treat the retained reconnect snapshot as live', () => {
    const store = new LocalChannelStore<RadarSnapshot>();
    const { rendered } = setup(store);
    act(() => store.accept(frame(1), resets));
    act(() => store.setState('reconnecting'));
    expect(store.getSnapshot().current).not.toBeNull();
    expect(container!.textContent).toBe('false');
    act(() => store.setState('connecting'));
    act(() => store.setState('awaiting-baseline'));
    expect(rendered).toHaveBeenCalledTimes(3);
    act(() => store.accept(frame(2), resets));
    expect(container!.textContent).toBe('true');
    act(() => store.setState('closed'));
    expect(container!.textContent).toBe('false');
  });

  it('releases the previous source on replacement and on unmount', () => {
    const first = new LocalChannelStore<RadarSnapshot>();
    const second = new LocalChannelStore<RadarSnapshot>();
    const firstRead = vi.spyOn(first, 'getSnapshot');
    const secondRead = vi.spyOn(second, 'getSnapshot');
    const { render } = setup(first);
    act(() => second.accept(frame(1), resets));
    render(second);
    expect(container!.textContent).toBe('true');
    firstRead.mockClear();
    act(() => first.accept(frame(2), resets));
    expect(firstRead).not.toHaveBeenCalled();
    act(() => root!.unmount());
    root = undefined;
    secondRead.mockClear();
    act(() => second.accept(frame(2), resets));
    expect(secondRead).not.toHaveBeenCalled();
  });
});
