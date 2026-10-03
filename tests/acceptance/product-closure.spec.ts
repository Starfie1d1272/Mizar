import { expect, test } from './companion-isolation.js';

for (const width of [320, 390, 1280]) {
  test(`product tools fit ${width}px and retain focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const route of ['/preview', '/operator/hud', '/debug', '/workspace']) {
      await page.goto(route);
      await expect(page.locator('body')).not.toBeEmpty();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
      await page.screenshot({ path: `/tmp/mizar-107-${route.replaceAll('/', '-')}-${width}.png` });
    }
  });
}
test('live status is compact, unknown stays unknown, and reminders require a claim', async ({
  page,
}) => {
  let assigned = false;
  let obs: unknown = null;
  const guidance = {
    matchId: null,
    phase: 'live',
    task: '比赛进行中',
    nextStep: '关注比赛与直播状态。',
    currentMap: 'de_mirage',
    nextMap: null,
    result: null,
    interMapReminder: false,
    rivalhubUrl: null,
    bilibili: 'unknown',
  };
  await page.route('**/local/v1/production-guidance', (route) =>
    route.fulfill({ json: { ...guidance, broadcastAssigned: assigned } }),
  );
  await page.route('**/local/v1/production', (route) =>
    route.fulfill({ json: { mode: 'live', revision: '1', canEnter: true } }),
  );
  await page.route('**/local/v1/obs', (route) =>
    obs ? route.fulfill({ json: obs }) : route.fulfill({ status: 503 }),
  );
  await page.goto('/workspace/left');
  await expect(page.getByText('OBS 无法确认', { exact: true })).toBeVisible();
  await expect(page.getByText('Bilibili 无法确认', { exact: true })).toBeVisible();
  obs = { connection: 'connected', streaming: false, sceneAligned: true, findings: [] };
  await page.reload();
  await expect(page.getByText('OBS 未推流', { exact: true })).toBeVisible();
  await expect(page.getByText('比赛进行中，OBS 未推流，请检查 OBS。')).toHaveCount(0);
  assigned = true;
  await page.reload();
  await expect(page.getByText('比赛进行中，OBS 未推流，请检查 OBS。')).toBeVisible();
});
