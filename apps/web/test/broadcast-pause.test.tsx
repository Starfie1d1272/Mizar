// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getBuiltinResolvedPreset, type HudResolvedPreset } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { HUD_RENDERER_REGISTRY } from '../src/program/hud-renderer-registry';
import { GameplayHud } from '../src/program/GameplayHud';
import { getProgramFixture } from '../src/program/fixtures';
import { radarSnapshotForProgramFixture } from '../src/program/fixtures/radar-fixtures';
import { BroadcastBrand } from '../src/program/widgets/broadcast-pause/BroadcastBrand';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});
function mount(snapshot: ProgramSnapshot, preset: HudResolvedPreset, node?: HTMLDivElement) {
  const container = node ?? document.createElement('div');
  root ??= createRoot(container);
  act(() =>
    root!.render(
      <GameplayHud
        snapshot={snapshot}
        rendererRegistry={{
          ...HUD_RENDERER_REGISTRY,
          radar: {
            availability: 'implemented',
            source: 'radar',
            renderer: () => <div data-radar-probe="true" />,
          },
        }}
        resolvedPreset={preset}
        radarSnapshot={radarSnapshotForProgramFixture('real-live-rich')}
      />,
    ),
  );
  return container;
}
describe('Shared broadcast pause composition', () => {
  it.each(['iem', 'ewc', 'perfectworld', 'esl'])(
    'swaps physical pause/history sides in %s without changing Program or map strip',
    (style) => {
      const preset = getBuiltinResolvedPreset(`builtin:${style}-preset`);
      const left = getProgramFixture('real-timeout-ct')!;
      const before = JSON.stringify(left);
      const node = mount(left, preset);
      expect(node.querySelector('[data-pause-info-side="left"]')).not.toBeNull();
      expect(node.querySelector('[data-pause-history-side="right"]')).not.toBeNull();
      expect(node.querySelectorAll('[data-pause-player]')).toHaveLength(10);
      expect(node.querySelector('[data-hud-widget="series-strip"]')).not.toBeNull();
      expect(node.querySelector('[data-history-mode="freeze"]')).toBeNull();
      expect(node.querySelector('.broadcast-pause__countdown > strong')?.textContent).toBe('0:30');
      expect(node.querySelectorAll('.broadcast-pause__economy strong')).toHaveLength(4);
      expect(JSON.stringify(left)).toBe(before);
      mount(getProgramFixture('real-timeout-t')!, preset, node);
      expect(node.querySelector('[data-pause-info-side="right"]')).not.toBeNull();
      expect(node.querySelector('[data-pause-history-side="left"]')).not.toBeNull();
      mount(getProgramFixture('real-live-rich')!, preset, node);
      expect(node.querySelector('[data-broadcast-pause]')).toBeNull();
      expect(node.querySelectorAll('.player-rail__card')).toHaveLength(10);
    },
  );
  it('follows entrant mapping after halftime, keeps unresolved owners neutral, and never invents a technical countdown', () => {
    const preset = getBuiltinResolvedPreset('builtin:iem-preset');
    const swapped = getProgramFixture('series-halftime-swap')!;
    const timeout = {
      ...swapped,
      payload: {
        ...swapped.payload,
        clock: { ...swapped.payload.clock!, phase: 'timeout_ct' as const, endsInSeconds: 22 },
      },
    };
    const node = mount(timeout, preset);
    expect(node.querySelector('[data-pause-info-side="right"]')).not.toBeNull();
    mount(getProgramFixture('series-mapping-unavailable')!, preset, node);
    expect(node.querySelector('[data-pause-info-side="center"]')).not.toBeNull();
    mount(getProgramFixture('real-paused')!, preset, node);
    expect(node.querySelector('.broadcast-pause__countdown')).toBeNull();
    expect(node.textContent).toContain('TECH PAUSE');
    expect(node.textContent).toContain('WAITING TO RESUME');
  });
  it('reads remaining counts directly, including regulation, overtime, zero and missing evidence', () => {
    const preset = getBuiltinResolvedPreset('builtin:iem-preset');
    const base = getProgramFixture('real-timeout-ct')!;
    const node = mount(base, preset);
    for (const count of [3, 1, 0, null]) {
      mount(
        {
          ...base,
          payload: {
            ...base.payload,
            map: { ...base.payload.map, timeoutsRemaining: { ct: count, t: count } },
          },
        },
        preset,
        node,
      );
      for (const economy of node.querySelectorAll('.broadcast-pause__economy')) {
        const slots = economy.querySelector('.broadcast-pause__timeout-slots');
        if (count === null)
          expect(economy.querySelector(':scope > div:last-child > strong')?.textContent).toBe('—');
        else {
          expect(slots?.getAttribute('data-timeouts-remaining')).toBe(String(count));
          expect(slots?.querySelectorAll('i')).toHaveLength(3);
          expect(slots?.querySelectorAll('[data-timeout-available="true"]')).toHaveLength(count);
        }
      }
      expect(node.querySelector('.broadcast-pause__remaining-number b')?.textContent).toBe(
        count === null ? '—' : String(count),
      );
    }
  });
  it('uses one slot in overtime and expands for a larger game-reported counter', () => {
    const preset = getBuiltinResolvedPreset('builtin:iem-preset');
    const base = getProgramFixture('real-timeout-ct')!;
    const node = mount(base, preset);
    for (const [roundNumber, count, total] of [
      [27, 1, 1],
      [27, 0, 1],
      [5, 4, 4],
    ] as const) {
      mount(
        {
          ...base,
          payload: {
            ...base.payload,
            map: { ...base.payload.map, roundNumber, timeoutsRemaining: { ct: count, t: count } },
          },
        },
        preset,
        node,
      );
      for (const slots of node.querySelectorAll('.broadcast-pause__timeout-slots')) {
        expect(slots.querySelectorAll('i')).toHaveLength(total);
        expect(slots.querySelectorAll('[data-timeout-available="true"]')).toHaveLength(count);
      }
    }
  });
  it('honors saved visibility and auxiliaries, and keeps independent Radar available when Program becomes stale', () => {
    const preset = getBuiltinResolvedPreset('builtin:ewc-preset');
    preset.layout.widgets['round-history'].visible = false;
    preset.layout.widgets['team-t-rail'].visible = false;
    preset.widgets['team-ct-rail'].settings = {
      ...preset.widgets['team-ct-rail'].settings,
      showAvatar: false,
      showMoney: false,
      showLoadout: false,
      showUtility: false,
      showTeamSummary: false,
    };
    const base = getProgramFixture('real-timeout-ct')!;
    const node = mount(base, preset);
    expect(node.querySelector('[data-history-mode]')).toBeNull();
    expect(node.querySelectorAll('[data-pause-player]')).toHaveLength(5);
    expect(
      node.querySelectorAll(
        '.broadcast-pause__avatar img, .broadcast-pause__equipment .broadcast-pause__icon',
      ),
    ).toHaveLength(0);
    expect(node.querySelector('.broadcast-pause__money')?.textContent).toBe('');
    expect(node.querySelectorAll('.broadcast-pause__economy strong')).toHaveLength(0);
    expect(node.querySelectorAll('[data-series-win-slot]')).toHaveLength(4);
    mount(
      {
        ...base,
        payload: { ...base.payload, status: { ...base.payload.status, telemetry: 'stale' } },
      },
      preset,
      node,
    );
    expect(node.querySelector('[data-broadcast-pause]')).toBeNull();
    expect(node.querySelector('[data-hud-widget="radar"]')).not.toBeNull();
    preset.widgets['top-score-bar'].settings = {
      ...preset.widgets['top-score-bar'].settings,
      showTimeout: false,
    };
    mount(base, preset, node);
    expect(node.querySelector('[data-broadcast-pause]')).toBeNull();
    mount(base, getBuiltinResolvedPreset(), node);
    expect(node.querySelector('[data-broadcast-pause]')).toBeNull();
  });
  it('prioritizes the supplied event and bounds optional platform/sponsor assets', () => {
    const node = document.createElement('div');
    root = createRoot(node);
    act(() =>
      root!.render(
        <BroadcastBrand
          competition="Example Open"
          stage="GRAND FINAL"
          branding={{
            eventLogoUrl: '/event.svg',
            platformLogoUrl: '/platform.svg',
            sponsors: Array.from({ length: 5 }, (_, i) => ({
              name: `Sponsor ${i}`,
              logoUrl: `/s${i}.svg`,
            })),
          }}
        />,
      ),
    );
    expect(node.querySelector('.broadcast-pause__event')?.textContent).toBe('Example Open');
    expect(
      node.querySelector('.broadcast-pause__brand-main')?.getAttribute('data-event-present'),
    ).toBe('true');
    expect(node.querySelectorAll('.broadcast-pause__partners img')).toHaveLength(4);
  });
});
