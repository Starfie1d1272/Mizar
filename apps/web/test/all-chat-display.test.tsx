import { BroadcastPause } from '../src/program/widgets/broadcast-pause/BroadcastPause';
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

it('keeps pause chat opposite history, with shared visibility and expiration rules', () => {
  for (const design of ['current', 'ewc', 'iem', 'perfectworld', 'esl'] as const) {
    for (const phase of ['timeout_ct', 'timeout_t', 'paused'] as const) {
      const snapshot = structuredClone(getProgramFixture('live-canonical')!);
      snapshot.payload.clock = { ...snapshot.payload.clock!, phase };
      snapshot.payload.allChat = [
        {
          id: 'pause-chat',
          sender: '选手',
          text: '暂停消息',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ];
      const preset = structuredClone(getBuiltinResolvedPreset());
      const render = () =>
        renderToStaticMarkup(
          createElement(BroadcastPause, { snapshot, resolvedPreset: preset, design }),
        );
      const html = render();
      expect(html).toContain('aria-label="公共聊天"');
      const historySide = html.match(/data-pause-history-side="(left|right)"/)?.[1];
      if (historySide)
        expect(html).toContain(
          `data-pause-chat-side="${historySide === 'left' ? 'right' : 'left'}"`,
        );
      expect(html).toContain(
        `data-pause-chat-kind="${phase === 'paused' ? 'technical' : 'tactical'}"`,
      );
      preset.widgets['team-t-rail'].settings = {
        ...preset.widgets['team-t-rail'].settings,
        showAllChat: false,
      };
      expect(render()).not.toContain('aria-label="公共聊天"');
      preset.widgets['team-t-rail'].settings = {
        ...preset.widgets['team-t-rail'].settings,
        showAllChat: true,
      };
      snapshot.payload.allChat[0]!.expiresAt = '2000-01-01T00:00:00.000Z';
      expect(render()).not.toContain('aria-label="公共聊天"');
    }
  }
});
