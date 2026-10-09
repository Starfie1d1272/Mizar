// @vitest-environment jsdom

import { type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import type { RadarSnapshot } from '@mizar/protocol/radar';

import { GameplayHud } from '../src/program/GameplayHud';
import { getProgramFixture } from '../src/program/fixtures';
import {
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
    expect(childWidget?.props.snapshot).toEqual(snapshot);
    expect(childWidget?.props.snapshot).not.toHaveProperty('payload.coverage.grenades');
    expect(childWidget?.props.snapshot).not.toHaveProperty('payload.grenades');
  });
});
