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
  await expect(page.locator('.waiting-event')).toContainText('M2 示例赛');
  await expect(page.locator('.waiting-team img')).toHaveCount(0);
  await page.goto('/program/match-result?preview=1');
  await expect(page.locator('.summary-caption')).toContainText('最后一图');
  await expect(page.locator('.summary-player')).toHaveCount(10);
});
