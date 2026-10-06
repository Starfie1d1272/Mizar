// @vitest-environment jsdom

import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import type { RadarSnapshot } from '@mizar/protocol/radar';

import { GameplayHud, themeStyle } from '../src/program/GameplayHud';
import { HudEditorOverlay } from '../src/program/HudEditorOverlay';
import { getProgramFixture } from '../src/program/fixtures';
import {
  assertHudRendererRegistryConsistency,
  HUD_RENDERER_REGISTRY,
  type HudRendererRegistry,
  type HudWidgetRendererProps,
  type RadarHudWidgetRendererProps,
} from '../src/program/hud-renderer-registry';
import { programPresentationBoundaryKey } from '../src/program/ProgramPage';

function childrenOf(element: ReturnType<typeof GameplayHud>): readonly unknown[] {
  if (element === null) throw new Error('HUD element should render');
  return (element as ReactElement<{ readonly children?: readonly unknown[] }>).props.children ?? [];
}

function fakeRadarSnapshot(): RadarSnapshot {
  return {
    type: 'snapshot',
    protocolVersion: 1,
    channel: 'radar',
    schemaVersion: 2,
    channelSeq: 1,
    cursor: {
      producerInstanceId: 'gameplay-hud-radar',
      liveSessionId: 'live-session-1',
      runtimeSeq: 1,
      programSourceGeneration: 0,
      programReceiveSequence: 1,
      mapEpoch: 0,
    },
    payload: {
      telemetryFreshness: 'fresh',
      identityState: 'matched',
      mapName: 'de_mirage',
      observedPlayerSourceId: null,
      coverage: { allPlayers: 'present', bomb: 'present', grenades: 'present' },
      players: [],
      bomb: null,
      grenades: [],
    },
  };
}

describe('GameplayHud shared renderer boundary', () => {
  it('compacts the default radar only without map-strip content and preserves explicit editor placement', () => {
    const resolvedPreset = getBuiltinResolvedPreset();
    const snapshot = structuredClone(getProgramFixture('live-canonical')!);
    snapshot.payload.series!.veto = [];
    snapshot.payload.series!.maps.forEach((map) => {
      map.selection = { kind: 'unknown' };
    });
    const top = (preset = resolvedPreset) => {
      const hud = GameplayHud({
        snapshot,
        resolvedPreset: preset,
        radarSnapshot: fakeRadarSnapshot(),
      });
      const children = childrenOf(hud) as (ReactElement<{
        'data-hud-widget': string;
        style: { top: string };
      }> | null)[];
      return children.find((child) => child?.props['data-hud-widget'] === 'radar')!.props.style.top;
    };
    expect(top()).toBe('36px');
    snapshot.payload.series!.maps[0]!.selection = { kind: 'decider' };
    expect(top()).toBe('116px');
    snapshot.payload.series!.maps[0]!.selection = { kind: 'unknown' };
    expect(
      top({
        ...resolvedPreset,
        layout: {
          ...resolvedPreset.layout,
          widgets: {
            ...resolvedPreset.layout.widgets,
            radar: { ...resolvedPreset.layout.widgets.radar, offsetY: 300 },
          },
        },
      }),
    ).toBe('300px');
  });
  let root: Root | undefined;

  afterEach(() => {
    if (root !== undefined) {
      act(() => root?.unmount());
      root = undefined;
    }
  });

  it('fails closed for a missing or non-fresh Program snapshot', () => {
    const resolvedPreset = getBuiltinResolvedPreset();
    expect(
      GameplayHud({
        resolvedPreset,
        snapshot: null,
      }),
    ).toBeNull();
    expect(
      GameplayHud({
        resolvedPreset,
        snapshot: getProgramFixture('awaiting-neutral'),
      }),
    ).toBeNull();
  });

  it('renders the implemented Match Header widgets while editor keeps the registry chrome', () => {
    const resolvedPreset = getBuiltinResolvedPreset();
    const snapshot = getProgramFixture('live-canonical');
    expect(snapshot).not.toBeNull();
    const program = GameplayHud({
      resolvedPreset,
      snapshot,
    });
    const editor = HudEditorOverlay({ resolvedPreset, selectedWidgetId: null });

    expect(program).toMatchObject({ props: { 'data-gameplay-hud': 'true' } });
    expect(childrenOf(program)).toHaveLength(10);
    expect(childrenOf(program).filter((child) => child !== null)).toHaveLength(6);
    expect(editor).toMatchObject({ props: { 'data-hud-editor-overlay': 'true' } });
    expect(childrenOf(editor)).toHaveLength(10);
    const preview = HudEditorOverlay({
      mode: 'preview',
      resolvedPreset,
      selectedWidgetId: null,
    });
    expect(childrenOf(preview)).toHaveLength(10);
  });

  it('never exposes unimplemented widgets even when a saved layout makes them visible', () => {
    const preset = getBuiltinResolvedPreset();
    const resolvedPreset = {
      ...preset,
      layout: {
        ...preset.layout,
        widgets: {
          ...preset.layout.widgets,
          objective: { ...preset.layout.widgets.objective, visible: true },
          'round-result': { ...preset.layout.widgets['round-result'], visible: true },
        },
      },
    };
    for (const mode of ['layout', 'preview'] as const) {
      const editor = HudEditorOverlay({ resolvedPreset, selectedWidgetId: null, mode });
      const children = childrenOf(editor);
      expect(children[9]).toBeNull();
      expect(children[8]).toBeNull();
      if (mode === 'preview') expect(children.every((child) => child === null)).toBe(true);
    }
  });

  it('keeps Radar rendered when Program truth is unavailable and hides Program widgets', () => {
    function RadarProbe({ radarSnapshot }: RadarHudWidgetRendererProps) {
      return <div data-radar-probe={radarSnapshot?.channel ?? 'missing'} />;
    }

    const registry: HudRendererRegistry = {
      ...HUD_RENDERER_REGISTRY,
      radar: { availability: 'implemented', source: 'radar', renderer: RadarProbe },
    };
    const program = GameplayHud({
      rendererRegistry: registry,
      resolvedPreset: getBuiltinResolvedPreset(),
      snapshot: null,
      radarSnapshot: fakeRadarSnapshot(),
    });

    expect(program).not.toBeNull();
    expect(childrenOf(program).filter((child) => child !== null)).toHaveLength(1);
    const wrapper = (
      childrenOf(program) as Array<ReactElement<{ readonly 'data-hud-widget': string }>>
    ).find((child) => child?.props?.['data-hud-widget'] === 'radar');
    expect(wrapper).toBeDefined();
    const radarRenderer = (wrapper?.props as { readonly children?: ReactElement }).children;
    expect(radarRenderer).toMatchObject({
      props: { radarSnapshot: { channel: 'radar' } },
    });
  });

  it('adapts every resolved semantic field into theme-owned variables', () => {
    const style = themeStyle(getBuiltinResolvedPreset().theme) as Record<string, string | number>;
    expect(style).toMatchObject({
      '--mizar-event-accent': '#2d7ff9',
      '--mizar-hud-text-primary': '#f4f8fd',
      '--mizar-hud-text-muted': '#9aa8b7',
      '--mizar-side-ct': '#2d7ff9',
      '--mizar-side-t': '#f0b84b',
      '--mizar-hud-state-danger': '#f16c6c',
      '--mizar-hud-state-warning': '#f0b84b',
      '--mizar-hud-state-success': '#c8ef78',
      '--mizar-hud-state-unknown': '#8d9aaa',
      '--mizar-hud-objective-bomb': '#f16c6c',
      '--mizar-hud-objective-defuse': '#83d8e8',
      '--mizar-hud-surface-opacity': 0.88,
      '--mizar-hud-border-opacity': 0.16,
      '--mizar-hud-radius-sm': '0px',
      '--mizar-hud-radius-md': '0px',
      '--mizar-hud-radius-lg': '0px',
      '--mizar-hud-font-family': 'Inter',
    });
  });

  it('keeps framework-neutral and Web renderer availability aligned', () => {
    expect(() => assertHudRendererRegistryConsistency()).not.toThrow();
    expect(
      Object.values(HUD_RENDERER_REGISTRY).filter((entry) => entry.renderer !== null),
    ).toHaveLength(8);
  });

  it('renders hook-based components through the same registry and resets only at the boundary key', () => {
    function HookRenderer({ snapshot }: HudWidgetRendererProps) {
      const [count, setCount] = useState(0);
      return (
        <button onClick={() => setCount((current) => current + 1)} type="button">
          {snapshot.cursor.runtimeSeq}:{count}
        </button>
      );
    }

    const registry: HudRendererRegistry = {
      ...HUD_RENDERER_REGISTRY,
      radar: { availability: 'implemented', source: 'program', renderer: HookRenderer },
    };
    const resolvedPreset = getBuiltinResolvedPreset();
    const snapshot = getProgramFixture('live-canonical');
    if (snapshot === null) throw new Error('fixture missing');
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <GameplayHud
          key="accepted:1"
          rendererRegistry={registry}
          resolvedPreset={resolvedPreset}
          snapshot={snapshot}
        />,
      );
    });
    const button = container.querySelector('button');
    expect(button?.textContent).toBe(`${snapshot.cursor.runtimeSeq}:0`);
    act(() => button?.click());
    expect(container.querySelector('button')?.textContent).toBe(`${snapshot.cursor.runtimeSeq}:1`);

    act(() => {
      root?.render(
        <GameplayHud
          key="accepted:1"
          rendererRegistry={registry}
          resolvedPreset={resolvedPreset}
          snapshot={{ ...snapshot, cursor: { ...snapshot.cursor, runtimeSeq: 43 } }}
        />,
      );
    });
    expect(container.querySelector('button')?.textContent).toBe('43:1');

    act(() => {
      root?.render(
        <GameplayHud
          key="accepted:2"
          rendererRegistry={registry}
          resolvedPreset={resolvedPreset}
          snapshot={snapshot}
        />,
      );
    });
    expect(container.querySelector('button')?.textContent).toBe(`${snapshot.cursor.runtimeSeq}:0`);

    const editor = HudEditorOverlay({
      rendererRegistry: registry,
      resolvedPreset,
      selectedWidgetId: null,
    });
    expect(childrenOf(editor).some((child) => child !== null)).toBe(true);
  });

  it('changes the presentation boundary for accepted cursor resets and fail-closed states', () => {
    const snapshot = getProgramFixture('live-canonical');
    if (snapshot === null) throw new Error('fixture missing');

    const accepted = programPresentationBoundaryKey(snapshot, 'live');
    expect(accepted).toContain(
      `${snapshot.cursor.producerInstanceId}:${snapshot.cursor.liveSessionId ?? 'unbound'}:${snapshot.cursor.programSourceGeneration}:${snapshot.cursor.mapEpoch}`,
    );
    expect(programPresentationBoundaryKey(snapshot, 'reconnecting')).toBe('fail-closed');
    expect(
      programPresentationBoundaryKey(
        { ...snapshot, cursor: { ...snapshot.cursor, mapEpoch: snapshot.cursor.mapEpoch + 1 } },
        'live',
      ),
    ).not.toBe(accepted);
    expect(
      programPresentationBoundaryKey(
        {
          ...snapshot,
          payload: {
            ...snapshot.payload,
            status: { ...snapshot.payload.status, telemetry: 'stale' },
          },
        },
        'live',
      ),
    ).toBe('fail-closed');
  });

  it('keeps ProgramSnapshot isolated and never copies or merges Radar payload into Program widget props', () => {
    function ProbeRenderer() {
      return <div data-probe="true" />;
    }

    const registry: HudRendererRegistry = {
      ...HUD_RENDERER_REGISTRY,
      'top-score-bar': { availability: 'implemented', source: 'program', renderer: ProbeRenderer },
    };
    const resolvedPreset = getBuiltinResolvedPreset();
    const snapshot = getProgramFixture('live-canonical');
    if (snapshot === null) throw new Error('fixture missing');

    const fakeRadar = fakeRadarSnapshot();

    const program = GameplayHud({
      rendererRegistry: registry,
      resolvedPreset,
      snapshot,
      radarSnapshot: fakeRadar,
    });

    expect(program).not.toBeNull();
    const children = childrenOf(program) as Array<
      ReactElement<{
        readonly 'data-hud-widget': string;
        readonly children: ReactElement<HudWidgetRendererProps>;
      }>
    >;
    const scoreBarWrapper = children.find(
      (child) => child?.props?.['data-hud-widget'] === 'top-score-bar',
    );
    const childWidget = scoreBarWrapper?.props?.children;
    expect(childWidget).toBeDefined();
    // Verify child widgets receive exact unpolluted ProgramSnapshot
    expect(childWidget?.props.snapshot).toBe(snapshot);
    expect(childWidget?.props.snapshot).not.toHaveProperty('payload.coverage.grenades');
    expect(childWidget?.props.snapshot).not.toHaveProperty('payload.grenades');
  });
});
