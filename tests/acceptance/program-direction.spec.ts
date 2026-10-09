import { readFileSync } from 'node:fs';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import { expect, test } from './companion-isolation.js';

test('summary retains both five-player rosters without clipping across formats and media', async ({
  page,
}) => {
  for (const variant of ['default', 'bo1', 'bo5', 'no-media', 'long-names']) {
    await page.goto(`/program/halftime?preview=1&variant=${variant}`);
    const board = page.locator('.summary-players');
    await expect(board).toBeVisible();
    const bounds = (await board.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1080);
    await expect(page.locator('.summary-side--a .summary-player')).toHaveCount(5);
    await expect(page.locator('.summary-side--b .summary-player')).toHaveCount(5);
    for (const player of await page.locator('.summary-player').all()) {
      const row = (await player.boundingBox())!;
      expect(row.y).toBeGreaterThanOrEqual(bounds.y);
      expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    if (variant === 'no-media') {
      await expect(page.locator('.summary-avatar img, .summary-entrant-logo')).toHaveCount(0);
    }
    if (variant === 'bo1' || variant === 'bo5')
      await expect(page.locator('.summary-map')).toHaveCount(variant === 'bo1' ? 1 : 5);
    await expect(page.getByText('ADR', { exact: true })).toHaveCount(0);
  }
});

test('map result shows the captured winner and score without overlapping its logo', async ({
  page,
}) => {
  await page.goto('/program/map-result?preview=1');
  await expect(page.locator('.result-sting')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.result-side--a .result-round-score')).toHaveText('13');
  await expect(page.locator('.result-side--b .result-round-score')).toHaveText('6');
  const leftScore = (await page.locator('.result-side--a .result-round-score').boundingBox())!;
  const leftLogo = (await page.locator('.result-side--a .result-logo').boundingBox())!;
  expect(leftLogo.x - (leftScore.x + leftScore.width)).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.result-side--a')).toHaveAttribute('data-winner', 'true');
});

test('waiting and match result use event identity and last-map statistics', async ({ page }) => {
  await page.goto('/program/waiting?preview=1&variant=no-media');
  await expect(page.locator('.waiting-event')).toContainText('ESL Pro League Season 24');
  await expect(page.locator('.waiting-team img')).toHaveCount(0);
  await page.goto('/program/match-result?preview=1');
  await expect(page.locator('.summary-caption')).toContainText('FINAL MAP STATS');
  await expect(page.locator('.summary-player')).toHaveCount(10);
});

test('waiting exposes source-derived schedule and summary logos have clear space', async ({
  page,
}) => {
  await page.goto('/program/waiting?preview=1');
  await expect(page.locator('.waiting-schedule--previous')).toContainText('1 : 2');
  await expect(page.locator('.waiting-schedule--next')).toContainText('VS');
  await expect(page.locator('.waiting-time')).toContainText('SCHEDULED');
  await expect(page.locator('.waiting-time')).toContainText('03:00');
  await expect(page.locator('.waiting-time')).toContainText('UTC+8');
  await page.goto('/program/waiting?preview=1&variant=no-schedule');
  await expect(page.locator('.waiting-schedule article')).toHaveCount(0);
  await page.goto('/program/halftime?preview=1');
  const logo = await page.locator('.summary-entrant-logo').first().boundingBox();
  const maps = await page.locator('.summary-map-cards').boundingBox();
  expect(maps!.x - logo!.x - logo!.width).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.summary-map-tab').first()).toHaveText('INFERNO');
  await expect(page.locator('.summary-map-pick').last()).toHaveText('DECIDER');
  await expect(page.locator('.summary-stat-axis > span').first()).toHaveText('K/D');
  await expect(page.locator('.summary-player-stats').first()).toHaveText('5–7');
  await expect(page.locator('.summary-map-art > strong').first()).toHaveText('6 – 6');
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

test('result headers stay clear of map tabs and winners appear only at match completion', async ({
  page,
}) => {
  for (const scene of ['waiting', 'halftime', 'intermap', 'map-result', 'match-result']) {
    await page.goto(`/program/${scene}?preview=1`);
    if (scene === 'halftime' || scene === 'intermap' || scene === 'match-result') {
      const footer = (await page.locator('.summary-footer').boundingBox())!;
      const tab = (await page.locator('.summary-map-tab').first().boundingBox())!;
      expect(footer.y + footer.height).toBeLessThanOrEqual(tab.y);
      await expect(page.locator('.summary-footer [data-winner="true"]')).toHaveCount(
        scene === 'match-result' ? 1 : 0,
      );
    }
  }
});
