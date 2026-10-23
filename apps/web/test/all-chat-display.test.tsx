import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlayerRail } from '../src/program/widgets/player-rails/PlayerRail';
import { getProgramFixture } from '../src/program/fixtures';
import {
  getHudWidgetDescriptor,
  getBuiltinResolvedPreset,
  placementToBox,
} from '@mizar/hud-config';
it('allows ALL chat to be hidden without hiding the player rail and exposes its switch on the right only', () => {
  const snapshot = structuredClone(getProgramFixture('live-canonical')!);
  snapshot.payload.allChat = [
    {
      id: 'public-example',
      sender: '公开样例',
      text: 'ALL test',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  ];
  const render = (showAllChat: boolean, widgetId: 'team-t-rail' | 'team-ct-rail' = 'team-t-rail') =>
    renderToStaticMarkup(
      createElement(PlayerRail, {
        resolvedPreset: getBuiltinResolvedPreset(),
        placement: getBuiltinResolvedPreset().layout.widgets[widgetId],
        box: placementToBox(widgetId, getBuiltinResolvedPreset().layout.widgets[widgetId]),
        snapshot,
        widgetId,
        settings: { variant: 'default', settings: { showAllChat } },
      }),
    );
  expect(render(true)).toContain('aria-label="公共聊天"');
  const hidden = render(false);
  expect(hidden).not.toContain('aria-label="公共聊天"');
  expect(hidden).toContain('aria-label="右选手栏"');
  expect(hidden).toContain('player-rail__card');
  expect(render(true, 'team-ct-rail')).not.toContain('aria-label="公共聊天"');
  expect(
    getHudWidgetDescriptor('team-t-rail').editorControls.some((x) => x.path === 'showAllChat'),
  ).toBe(true);
  expect(
    getHudWidgetDescriptor('team-ct-rail').editorControls.some((x) => x.path === 'showAllChat'),
  ).toBe(false);
});
