// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinResolvedPreset,
  getBuiltinTheme,
  getHudWidgetDescriptor,
  resolveHudPreset,
  switchHudWidgetVariant,
  type HudPreset,
} from '@mizar/hud-config';
import { HudWidgetInspector } from '../src/operator/HudWidgetInspector';
import { GameplayHud } from '../src/program/GameplayHud';
import { getProgramFixture } from '../src/program/fixtures';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});
function mount() {
  const container = document.createElement('div');
  root = createRoot(container);
  return container;
}

describe('Generic HUD widget settings', () => {
  it('builds boolean controls, updates validated draft and immediately updates shared preview', () => {
    const container = mount();
    const snapshot = getProgramFixture('focused-avatar');
    const before = JSON.stringify(snapshot);
    function Editor() {
      const [preset, setPreset] = useState<HudPreset>(getBuiltinPreset());
      return (
        <>
          <HudWidgetInspector
            widgetId="focused-player"
            value={preset.widgets['focused-player']}
            disabled={false}
            onChange={(value) =>
              setPreset({ ...preset, widgets: { ...preset.widgets, 'focused-player': value } })
            }
          />
          <GameplayHud
            snapshot={snapshot}
            resolvedPreset={resolveHudPreset(preset, getBuiltinLayout(), getBuiltinTheme())}
          />
        </>
      );
    }
    act(() => root!.render(<Editor />));
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
    expect(container.querySelector('.focused-player__metrics')).toBeNull();
    act(() => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
    expect(container.querySelector('.focused-player__metrics')).not.toBeNull();
    act(() => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
    expect(container.querySelector('.focused-player__metrics')).toBeNull();
    expect(container.querySelector('.focused-player__hp')).not.toBeNull();
    expect(container.querySelector('.focused-player__active')).not.toBeNull();
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('generates Radar select and resets variant settings from the registry defaults', () => {
    const container = mount();
    const updates: unknown[] = [];
    act(() =>
      root!.render(
        <HudWidgetInspector
          widgetId="radar"
          descriptor={{
            ...getHudWidgetDescriptor('radar'),
            editorControls: getHudWidgetDescriptor('radar').editorControls.map((control) => ({
              ...control,
              help: '由雷达投影决定可用视野。',
            })),
          }}
          value={getBuiltinPreset().widgets.radar}
          disabled={false}
          onChange={(value) => updates.push(value)}
        />,
      ),
    );
    const label = [...container.querySelectorAll('label')].find(
      (element) => element.textContent === '雷达视野',
    )!;
    const select = container.querySelector<HTMLSelectElement>(`select[id="${label.htmlFor}"]`)!;
    expect(select.getAttribute('aria-describedby')).toBeTruthy();
    expect(container.textContent).toContain('由雷达投影决定可用视野。');
    act(() => {
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(updates).toEqual([{ variant: 'default', settings: { zoomMode: 'auto' } }]);
    act(() =>
      root!.render(
        <HudWidgetInspector
          widgetId="focused-player"
          value={getBuiltinPreset().widgets['focused-player']}
          disabled={false}
          onChange={(value) => updates.push(value)}
        />,
      ),
    );
    const variant = container.querySelector('select')!;
    act(() => {
      variant.value = 'minimal';
      variant.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(updates[1]).toEqual(
      switchHudWidgetVariant(getHudWidgetDescriptor('focused-player'), 'minimal'),
    );
    act(() =>
      root!.render(
        <HudWidgetInspector
          widgetId="focused-player"
          value={getBuiltinPreset().widgets['focused-player']}
          disabled={true}
          onChange={() => {
            throw new Error('Disabled control updated');
          }}
        />,
      ),
    );
    expect(
      [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].every(
        (control) => control.disabled,
      ),
    ).toBe(true);
  });

  it('hides rail and score auxiliaries without changing core truth, mirrors or widget boxes', () => {
    const container = mount();
    const resolved = getBuiltinResolvedPreset();
    for (const id of ['team-ct-rail', 'team-t-rail', 'top-score-bar'] as const) {
      const descriptor = getHudWidgetDescriptor(id);
      resolved.widgets[id] = descriptor.validateSettings({
        variant: 'default',
        settings: Object.fromEntries(
          Object.entries(resolved.widgets[id].settings).map(([key, value]) => [
            key,
            typeof value === 'boolean' ? false : 'minimal',
          ]),
        ),
      });
    }
    const snapshot = getProgramFixture('real-live-rich');
    act(() => root!.render(<GameplayHud snapshot={snapshot} resolvedPreset={resolved} />));
    expect(container.querySelectorAll('.player-rail')).toHaveLength(2);
    expect(
      container.querySelectorAll(
        '.player-rail__money, .player-rail__weapons, .player-rail__equipment, .player-rail__utility-icons, .player-rail__summary',
      ),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-card-part="avatar"] img')).toHaveLength(0);
    expect(container.querySelectorAll('[data-health-value]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-score]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-series-win-slot]')).toHaveLength(0);
    expect(
      container.querySelectorAll(
        '[data-life-state="dead"] .player-rail__kd, [data-life-state="dead"] .player-rail__adr, [data-life-state="dead"] .player-rail__damage, [data-life-state="dead"] .player-rail__round-kill-badge',
      ),
    ).toHaveLength(0);
    expect(container.querySelector('[data-clock]')).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-hud-widget="team-ct-rail"]')!.style.width,
    ).toBe('440px');
  });
  it('minimal dead-state removes statistics while preserving identity and death evidence', () => {
    const container = mount();
    const resolved = getBuiltinResolvedPreset();
    const snapshot = getProgramFixture('player-rails-dead-observed');
    act(() => root!.render(<GameplayHud snapshot={snapshot} resolvedPreset={resolved} />));
    expect(container.querySelectorAll('[data-life-state="dead"]').length).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('[data-life-state="dead"] .player-rail__kd').length,
    ).toBeGreaterThan(0);
    for (const id of ['team-ct-rail', 'team-t-rail'] as const)
      resolved.widgets[id] = getHudWidgetDescriptor(id).validateSettings({
        variant: 'default',
        settings: { ...resolved.widgets[id].settings, deadInformation: 'minimal' },
      });
    act(() => root!.render(<GameplayHud snapshot={snapshot} resolvedPreset={resolved} />));
    expect(
      container.querySelectorAll(
        '[data-life-state="dead"] .player-rail__kd, [data-life-state="dead"] .player-rail__money, [data-life-state="dead"] .player-rail__adr, [data-life-state="dead"] .player-rail__damage, [data-life-state="dead"] .player-rail__round-kill-badge',
      ),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-life-state="dead"] .player-rail__name').length,
    ).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-life-state-label="dead"]').length).toBeGreaterThan(0);
  });
});
