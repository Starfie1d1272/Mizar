import { readFileSync } from 'node:fs';
import type { Page, WebSocketRoute } from '@playwright/test';
import { getBuiltinResolvedPreset } from '../../packages/hud-config/src/index.js';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import { adaptGsiPayload } from '../../packages/telemetry-gsi/src/adapter.js';
import { createProgramRuntime } from '../../apps/companion/src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../../apps/companion/src/projections/projection-coordinator.js';
import { createCstvSourceManagers } from '../../apps/companion/src/telemetry/cstv-source-manager.js';
import { expect, test } from './companion-isolation.js';

const artifact = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: unknown }> };
function sample(id: string) {
  return programSnapshotSchema.parse(artifact.fixtures[id]!.snapshot);
}
async function feed(page: Page, id: string) {
  const snapshot = sample(id);
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  await expect(page.locator('[data-gameplay-hud]')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('all five HUDs consume the same GSI nickname in player rails, focus and pause rosters', async ({
  page,
}) => {
  const runtime = createProgramRuntime('nickname-regression');
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    nowMonotonicMs: () => 0,
    predictionPublishCoalescing: false,
  });
  // Issue #208's reported nickname reconstructed in synthetic GSI; not a recording replay.
  const allplayers = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const steamid = String(76561198000000000n + BigInt(index));
      return [
        steamid,
        {
          steamid,
          name:
            index === 0
              ? 'The Beast TomatoDebu'
              : index === 5
                ? 'NJU美少女队｜小 明'
                : `Player ${index}`,
          team: index < 5 ? 'CT' : 'T',
          observer_slot: index,
          activity: 'playing',
          state: { health: 100, armor: 100 },
          weapons: { weapon_0: { name: 'weapon_knife', type: 'Knife', state: 'active' } },
        },
      ];
    }),
  );
  const snapshots = [];
  try {
    for (const [index, phase] of ['live', 'timeout_ct'].entries()) {
      const adapted = adaptGsiPayload(
        {
          map: {
            name: 'de_mirage',
            phase: 'live',
            round: 3,
            team_ct: { name: 'The Beast', score: 2 },
            team_t: { name: 'NJU美少女队', score: 1 },
          },
          round: { phase: 'live' },
          phase_countdowns: { phase, phase_ends_in: '30' },
          allplayers,
          player: Object.values(allplayers)[0],
        },
        { sequence: index + 1, receivedAt: '2026-10-09T00:00:00.000Z', receivedMonotonicMs: 0 },
      );
      if (!adapted.ok) throw new Error('nickname GSI reconstruction is invalid');
      coordinator.afterRuntimeMutation(runtime.acceptObservation(adapted.observation));
      snapshots.push(coordinator.getPublisher('program').getCurrent()!);
    }
    expect(coordinator.getRosterEvidence()?.ct[0]?.displayName).toBe('The Beast TomatoDebu');
    expect(runtime.getCurrentState().programTelemetry?.telemetry.allPlayers?.[0]?.displayName).toBe(
      'The Beast TomatoDebu',
    );
  } finally {
    await coordinator.close();
  }
  let snapshot = snapshots[0]!;
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/local/v1/program', (route) => {
    socket = route;
    route.send(JSON.stringify(snapshot));
  });
  let preset = getBuiltinResolvedPreset();
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({ json: { resolved: preset, etag: 'nickname', activeRevision: 'nickname' } }),
  );
  for (const style of ['mizar-default', 'ewc', 'iem', 'esl', 'perfectworld']) {
    preset = getBuiltinResolvedPreset(`builtin:${style}-preset`);
    snapshot = snapshots[0]!;
    await page.goto('/program?hud-config=companion');
    await expect(page.getByRole('article', { name: 'TomatoDebu player card' })).toBeVisible();
    await expect(page.locator('.focused-player__name')).toHaveText('TomatoDebu');
    await expect(page.getByRole('article', { name: '小 明 player card' })).toBeVisible();
    await expect(page.getByText('The Beast TomatoDebu', { exact: true })).toHaveCount(0);
    socket!.send(JSON.stringify(snapshots[1]));
    await expect(page.locator('[data-pause-player]')).toHaveCount(10);
    await expect(
      page.locator('[data-pause-player]').filter({ hasText: 'TomatoDebu' }),
    ).toBeVisible();
    await expect(page.locator('[data-pause-player]').filter({ hasText: '小 明' })).toBeVisible();
  }
});

test('default radar omits an absent series and the kill badge fits its slot', async ({ page }) => {
  const snapshot = sample('real-live-rich');
  // Controlled presentation edge: current map is available without a series plan.
  snapshot.payload.series = null;
  snapshot.payload.players.find(
    (player) => player.lifeState === 'alive' && player.state !== null,
  )!.state!.roundKills = 5;
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({
      json: { resolved: getBuiltinResolvedPreset(), etag: 'native', activeRevision: 'native' },
    }),
  );
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  await expect(page.locator('[data-gameplay-hud]')).toBeVisible();
  await expect(page.locator('.match-header__series-strip')).toHaveCount(0);
  const badge = page.locator('.player-rail__round-kill-badge[data-round-kills="5"]').first();
  await badge.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const bounds = (await badge.boundingBox())!;
  const slot = (await badge.locator('..').boundingBox())!;
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.x).toBeGreaterThanOrEqual(slot.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(slot.x + slot.width);
});

test('a ten-second action with unknown kit evidence paints a determinate defuse ring', async ({
  page,
}) => {
  const snapshot = sample('real-defusing');
  // Core's actual RC14 input regression proves this semantic action; this edge
  // verifies the browser does not gate the ring on optional equipment evidence.
  snapshot.payload.bomb!.action = {
    kind: 'defuse',
    sourcePlayerId: snapshot.payload.bomb!.sourcePlayerId,
    remainingSeconds: 9,
    durationSeconds: 10,
    hasDefuseKit: null,
  };
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program');
  const ring = page.locator('.objective-center__ring');
  await expect(ring).toHaveAttribute('data-progress', 'determinate');
  await expect(ring.locator('.objective-center__ring-fill')).toHaveAttribute(
    'stroke-dashoffset',
    '0.9',
  );
});

test('native ammo text meets WCAG contrast on the real live sample', async ({ page }) => {
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({
      json: { resolved: getBuiltinResolvedPreset(), etag: 'native', activeRevision: 'native' },
    }),
  );
  await feed(page, 'real-live-rich');
  const focus = page.locator('.focused-player');
  // A light ammo surface must explicitly override inherited white / muted text.
  const ratios = await focus.evaluate((el) => {
    const context = document.createElement('canvas').getContext('2d')!;
    const luminance = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((c) => {
        const value = c / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    };
    const surface = luminance(getComputedStyle(el).backgroundColor);
    return [
      ...el.querySelectorAll('.focused-player__ammo > strong, .focused-player__ammo > span'),
    ].map((text) => {
      const ink = luminance(getComputedStyle(text).color);
      return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
    });
  });
  expect(ratios).toHaveLength(2);
  expect(ratios.every((ratio) => ratio >= 4.5)).toBe(true);
});

test('Intro supports missing media and short mode, and reduced motion cancels movement', async ({
  page,
}) => {
  for (const variant of ['default', 'no-media', 'long-names']) {
    await page.goto(`/program/matchup?preview=1&variant=${variant}`);
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() =>
        page.locator('.intro-team--a').evaluate((el) => el.getAnimations({ subtree: true }).length),
      )
      .toBeGreaterThan(0);
    const movingSelector = (await page.locator('.intro-team--a img').count())
      ? '.intro-team--a img'
      : '.intro-team--a strong';
    const moving = page.locator(movingSelector);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => moving.evaluate((el) => el.getAnimations().length)).toBe(0);
    await expect(page.locator('.intro-art')).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  await page.goto('/program/matchup?preview=1&intro=short');
  await expect(page.locator('.intro-map')).toBeHidden();
  await expect(page.locator('.intro-hud')).toBeVisible();
  await page.goto('/program/waiting?preview=1');
  await expect(page.locator('.intro-body')).toHaveCount(0);
});

test('native C4 prediction uses real replay damage and remains distinct from health; opt-outs and legacy envelopes work', async ({
  page,
}) => {
  const rows = readFileSync(
    new URL('../../apps/web/public/fixtures/ancient-round-03/replay/frames.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row) as { cursor: { sequence: number }; program: unknown });
  const snapshot = programSnapshotSchema.parse(
    rows.find((row) => row.cursor.sequence === 1158)!.program,
  );
  const preset = getBuiltinResolvedPreset();
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({ json: { resolved: preset, etag: 'native', activeRevision: 'native' } }),
  );
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  const prediction = page.locator('.player-rail__bomb-prediction[data-bomb-prediction="lethal"]');
  await expect(prediction).toHaveCount(1);
  await expect(prediction).toHaveAttribute('aria-label', /255 damage, 0 HP remaining/);
  const card = prediction.locator('xpath=ancestor::*[contains(@class,"player-rail__card")]');
  await expect(card.locator('.player-rail__health-value')).toHaveText('73');
  preset.widgets['team-ct-rail'].settings.showBombPrediction = false;
  preset.widgets['team-t-rail'].settings.showBombPrediction = false;
  preset.widgets['focused-player'].settings.showMetrics = true;
  // A stored, current-version 360px envelope must remain usable, without silently moving it.
  delete preset.layout.widgets['focused-player'].size;
  await page.reload();
  await expect(prediction).toHaveCount(0);
  await expect(page.locator('.focused-player__metrics')).toBeVisible();
});

test('native smoke uses the shared cloud below combat information and clears at freeze', async ({
  page,
}) => {
  const preset = getBuiltinResolvedPreset();
  let snapshot = sample('real-live-rich');
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({ json: { resolved: preset, etag: 'smoke', activeRevision: 'smoke' } }),
  );
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.goto('/program?hud-config=companion');
  const affected = snapshot.payload.players.filter((player) => (player.state?.smoked ?? 0) > 0);
  expect(affected).toHaveLength(2);
  for (const player of affected) {
    const card = page.locator(`[data-player-card="${player.sourcePlayerId}"]`);
    await expect(card.locator(':scope > .broadcast-smoke')).toHaveAttribute('data-smoked', 'true');
    await expect(
      card.locator('.player-status-effects > .player-status-effects__smoke'),
    ).toHaveCount(0);
  }
  // Presentation-only observer switch; retain the captured player smoke values.
  snapshot.payload.observedPlayerSourceId = affected[0]!.sourcePlayerId;
  await page.reload();
  const focus = page.locator('.focused-player__face').last();
  await expect(focus.locator('.broadcast-smoke')).toHaveAttribute('data-smoked', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(focus.locator('.player-status-effects__smoke')).toHaveCSS('animation-name', 'none');
  snapshot = sample('real-post-explosion-freezetime');
  await page.reload();
  await expect(page.locator('.broadcast-smoke[data-smoked="true"]')).toHaveCount(0);
});

test('Pulse objective flash follows factual mode and reduced motion stops decorative animation', async ({
  page,
}) => {
  await page.route('**/local/v1/hud-config', (route) =>
    route.fulfill({
      json: { resolved: getBuiltinResolvedPreset(), etag: 'pulse', activeRevision: 'pulse' },
    }),
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await feed(page, 'real-defusing');
  const shell = page.locator('.match-header__score-shell');
  await expect
    .poll(() => shell.evaluate((element) => element.getAnimations().length))
    .toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => shell.evaluate((element) => element.getAnimations().length)).toBe(0);
  await expect(page.locator('.objective-center')).toHaveAttribute(
    'data-objective-mode',
    'defusing',
  );
  const observed = page.locator('.player-rail__card[data-observed="true"]').first();
  await expect(observed).toHaveCSS('animation-name', 'none');
});
