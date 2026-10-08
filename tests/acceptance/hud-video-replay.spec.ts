import { expect, test } from './companion-isolation.js';

test('plays real game background with live HUD and seeks both to the recorded C4 event', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  await page.goto('/operator/hud');
  await page.getByLabel('预览来源').selectOption('replay');
  await page.getByLabel('回放来源', { exact: true }).selectOption('epl-inferno-video');
  const replay = page.getByRole('region', { name: '重放控制' });
  const video = page.locator('video.hud-console__map-background');
  await expect(video).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThan(1);
  await expect(page.locator('[data-avatar-present="true"]')).toHaveCount(10);
  const logos = page.locator('.match-header__team-logo');
  await expect(logos).toHaveCount(2);
  await expect
    .poll(() =>
      logos.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
  const events = (
    await (await page.request.get('/fixtures/epl-inferno-video/replay/events.jsonl')).text()
  )
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          kind: string;
          sequence: number;
          scheduledElapsedUs: number;
        },
    );
  const planted = events.find((event) => event.kind === 'bomb-planted')!;
  await page.getByLabel('语义事件', { exact: true }).selectOption(planted.id);
  await expect(replay).toHaveAttribute('data-replay-cursor', String(planted.sequence));
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(planted.scheduledElapsedUs / 1e6, 2);
  await replay.getByRole('button', { name: '播放', exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(planted.scheduledElapsedUs / 1e6 + 0.5);
  await replay.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  const stopped = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  await page.waitForTimeout(300);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(
    stopped,
    2,
  );
  const cursor = await replay.getAttribute('data-replay-cursor');
  for (const preset of ['ewc', 'iem', 'perfectworld', 'esl', 'mizar-default']) {
    await page
      .getByRole('combobox', { name: '预设', exact: true })
      .selectOption(`builtin:${preset}-preset`);
    await expect(page.locator('[data-hud-preset-id]')).toHaveAttribute(
      'data-hud-preset-id',
      `builtin:${preset}-preset`,
    );
    await expect(replay).toHaveAttribute('data-replay-cursor', cursor!);
    expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(
      stopped,
      2,
    );
  }
  await page.getByRole('combobox', { name: '预览背景', exact: true }).selectOption('plain');
  await expect(video).toHaveCount(0);
  await page.getByRole('combobox', { name: '预览背景', exact: true }).selectOption('map');
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(stopped, 2);
  await page.screenshot({ path: '.agent-tmp/rc27-acceptance/evidence/editor-live-video.png' });
  await page.getByLabel('回放来源', { exact: true }).selectOption('epl-inferno-opening');
  await expect(video).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('rejects a corrupt background before offering a playable replay and recovers on source change', async ({
  page,
}) => {
  await page.route('**/fixtures/epl-inferno-video/replay/background.mp4', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: 'corrupt' }),
  );
  await page.goto('/operator/hud');
  await page.getByLabel('预览来源').selectOption('replay');
  await page.getByLabel('回放来源', { exact: true }).selectOption('epl-inferno-video');
  const replay = page.getByRole('region', { name: '重放控制' });
  await expect(replay.getByRole('alert')).toBeVisible();
  await expect(replay.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await expect(page.locator('video.hud-console__map-background')).toHaveCount(0);
  await page.getByLabel('回放来源', { exact: true }).selectOption('epl-inferno-opening');
  await expect(replay.getByRole('button', { name: '播放', exact: true })).toBeEnabled();
  await expect(replay.getByRole('alert')).toHaveCount(0);
});
