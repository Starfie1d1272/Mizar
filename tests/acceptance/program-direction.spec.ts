import { readFileSync } from 'node:fs';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import { expect, test } from './companion-isolation.js';

test('summary geometry is mirrored and stable across BO formats and absent media', async ({
  page,
}) => {
  for (const variant of ['default', 'bo1', 'bo5', 'no-media', 'long-names']) {
    await page.goto(`/program/halftime?preview=1&variant=${variant}`);
    const board = page.locator('.summary-players');
    await expect(board).toBeVisible();
    expect(await board.boundingBox()).toEqual({ x: 120, y: 360, width: 1680, height: 600 });
    await expect(page.locator('.summary-side--a .summary-player')).toHaveCount(5);
    await expect(page.locator('.summary-side--b .summary-player')).toHaveCount(5);
    expect((await page.locator('.summary-player').first().boundingBox())?.height).toBe(120);
    if (variant === 'no-media') {
      await expect(page.locator('.summary-player > img, .summary-entrant-logo')).toHaveCount(0);
      expect(await page.locator('.summary-map-cards').boundingBox()).toEqual({
        x: 120,
        y: 120,
        width: 1680,
        height: 180,
      });
    }
    if (variant === 'bo1' || variant === 'bo5')
      await expect(page.locator('.summary-map')).toHaveCount(variant === 'bo1' ? 1 : 5);
    await expect(page.getByText('ADR', { exact: true })).toHaveCount(0);
  }
});

test('map result uses the fixed score anchors and the real-derived final score', async ({
  page,
}) => {
  await page.goto('/program/map-result?preview=1');
  await expect(page.locator('.result-sting')).toBeVisible();
  expect(await page.locator('.result-side--a .result-round-score').boundingBox()).toEqual({
    x: 60,
    y: 260,
    width: 500,
    height: 480,
  });
  expect(await page.locator('.result-side--b .result-round-score').boundingBox()).toEqual({
    x: 1360,
    y: 260,
    width: 500,
    height: 480,
  });
  await expect(page.locator('.result-side--a .result-round-score')).toHaveText('14');
  await expect(page.locator('.result-side--b .result-round-score')).toHaveText('16');
});

test('intro hands off to HUD and reduced motion retains the same content', async ({ page }) => {
  await page.goto('/program/matchup?preview=1&intro=short');
  await expect(page.locator('.intro-team--a strong')).toHaveText('FURIA');
  await expect(page.locator('.intro-hud')).toHaveCSS('opacity', '1', { timeout: 4000 });
  await expect(page.locator('.intro-body')).toHaveCSS('opacity', '0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('.intro-star')).toBeHidden();
  await expect(page.locator('.intro-hud')).toHaveCSS('opacity', '1', { timeout: 4000 });
});

test('waiting and match result use event identity and last-map statistics', async ({ page }) => {
  await page.goto('/program/waiting?preview=1&variant=no-media');
  await expect(page.locator('.waiting-event')).toContainText('2026 NJU Rivals');
  await expect(page.locator('.waiting-team img')).toHaveCount(0);
  await page.goto('/program/match-result?preview=1');
  await expect(page.locator('.summary-caption')).toContainText('FINAL MAP STATS');
  await expect(page.locator('.summary-player')).toHaveCount(10);
});

test('waiting exposes source-derived schedule and summary logos have clear space', async ({
  page,
}) => {
  await page.goto('/program/waiting?preview=1');
  await expect(page.locator('.waiting-schedule--previous')).toContainText('0 : 2');
  await expect(page.locator('.waiting-schedule--next')).toContainText('VS');
  await expect(page.locator('.waiting-time')).toContainText('SCHEDULED');
  await page.goto('/program/waiting?preview=1&variant=no-schedule');
  await expect(page.locator('.waiting-schedule article')).toHaveCount(0);
  await page.goto('/program/halftime?preview=1');
  const logo = await page.locator('.summary-entrant-logo').first().boundingBox();
  const maps = await page.locator('.summary-map-cards').boundingBox();
  expect(maps!.x - logo!.x - logo!.width).toBeGreaterThanOrEqual(24);
  await expect(page.locator('.summary-map-tab').first()).toHaveText('ANCIENT');
  await expect(page.locator('.summary-map-pick').last()).toHaveText('DECIDER');
  await expect(page.locator('.summary-stat-axis > span').first()).toHaveText('K/D');
  await expect(page.locator('.summary-player-stats').first()).toHaveText('6–6');
  await expect(page.locator('.summary-player-stats').first().locator('span')).toHaveCount(3);
  await expect(page.locator('.summary-map-art > strong').first()).toHaveText('7 – 5');
});

test('live intro mounts after delayed presentation and polls do not repeatedly seek motion', async ({
  page,
}) => {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        '../../apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const snapshot = programSnapshotSchema.parse(artifact.fixtures['real-live-rich']!.snapshot);
  let clockStarted = 0;
  let mode = 'auto';
  let elapsed = 0;
  await page.routeWebSocket('**/local/v1/program', (socket) =>
    socket.send(JSON.stringify(snapshot)),
  );
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'matchup',
        revision: 'intro-1',
        available: ['matchup'],
        blocked: {},
        director: {
          mode,
          next: 'gameplay',
          reason: null,
          introDurationMs: 6000,
          sceneElapsedMs:
            mode === 'blocked' ? elapsed : clockStarted ? Date.now() - clockStarted : 0,
        },
      },
    }),
  );
  let releasePresentation!: () => void;
  const ready = new Promise<void>((resolve) => {
    releasePresentation = resolve;
  });
  await page.route('**/local/v1/program-presentation', async (route) => {
    await ready;
    await route.fulfill({
      json: {
        schemaVersion: 'mizar.program-presentation.v1',
        packageId: 'builtin:mizar-default',
        match: snapshot.payload.match,
        series: snapshot.payload.series,
        halftime: null,
        completed: [],
        eventLogoUrl: null,
        scheduledAt: null,
        previous: null,
        next: null,
      },
    });
  });
  await page.goto('/program/matchup');
  // Snapshot is available before presentation; a delayed HTTP response must still start handoff.
  await expect(page.locator('.intro-body')).toHaveCount(0);
  clockStarted = Date.now();
  releasePresentation();
  await expect(page.locator('.intro-team--a img')).toBeVisible();
  await expect
    .poll(() => page.locator('.intro-team--a img').evaluate((el) => el.getAnimations().length))
    .toBe(1);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Animation.prototype, 'currentTime')!;
    document.documentElement.dataset.seeks = '0';
    Object.defineProperty(Animation.prototype, 'currentTime', {
      ...descriptor,
      set(value) {
        document.documentElement.dataset.seeks = String(
          Number(document.documentElement.dataset.seeks) + 1,
        );
        descriptor.set!.call(this, value);
      },
    });
  });
  await expect
    .poll(() =>
      page
        .locator('.intro-team--a img')
        .evaluate((el) => Number(el.getAnimations()[0]?.currentTime ?? 0)),
    )
    .toBeGreaterThan(1600);
  expect(await page.locator('html').getAttribute('data-seeks')).toBe('0');
  elapsed = Date.now() - clockStarted;
  mode = 'blocked';
  await expect
    .poll(() =>
      page.locator('.intro-team--a img').evaluate((el) => el.getAnimations()[0]?.playState),
    )
    .toBe('paused');
  mode = 'auto';
  clockStarted = Date.now() - elapsed;
  await expect
    .poll(() =>
      page.locator('.intro-team--a img').evaluate((el) => el.getAnimations()[0]?.playState),
    )
    .toBe('running');
});
