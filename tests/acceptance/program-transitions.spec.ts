import { expect, test } from './companion-isolation.js';

test('preview fades between ready scenes, keeps at most two layers and latest selection wins', async ({
  page,
}) => {
  await page.goto('/preview');
  await expect(
    page.frameLocator('iframe[title="节目预览"]').locator('.waiting-layout'),
  ).toBeVisible();
  await page.evaluate(() => {
    const stage = document.querySelector('.preparation-program-preview')!;
    const samples: number[] = [];
    const animationDurations: number[] = [];
    Object.assign(window, {
      previewSamples: samples,
      previewAnimationDurations: animationDurations,
    });
    new MutationObserver(() => {
      samples.push(stage.querySelectorAll('iframe').length);
    }).observe(stage, { childList: true });
    // Keep the native method; call below supplies each element as its receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this instanceof HTMLIFrameElement && typeof options === 'object')
        animationDurations.push(Number(options.duration));
      return animate.call(this, frames, options);
    };
  });
  await page.getByRole('button', { name: '半场', exact: true }).click();
  await expect(
    page.frameLocator('iframe[title="节目预览"]').locator('.summary-players'),
  ).toBeVisible();
  await expect(page.locator('.preparation-program-preview iframe')).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const values = (window as unknown as { previewAnimationDurations?: unknown })
        .previewAnimationDurations;
      return Array.isArray(values)
        ? values.filter((value): value is number => typeof value === 'number')
        : [];
    }),
  ).toContain(300);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/program/intermap?*', async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: '图间', exact: true }).click();
  await expect(page.locator('.preparation-program-preview iframe')).toHaveCount(2);
  await page.getByRole('button', { name: '整场结果', exact: true }).click();
  release();
  await expect(
    page.frameLocator('iframe[title="节目预览"]').locator('.summary-caption'),
  ).toContainText('MATCH RESULT PENDING');
  await expect(page.locator('.preparation-program-preview iframe')).toHaveCount(1);
  expect(
    await page.evaluate(() => Math.max(...(Reflect.get(window, 'previewSamples') as number[]))),
  ).toBeLessThanOrEqual(2);
});

test('continuous preview is read-only and immediate gameplay cancels its pending sequence', async ({
  page,
}) => {
  const commands: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') commands.push(request.url());
  });
  await page.goto('/preview');
  await page.getByRole('button', { name: '播放演示', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('演示 1 / 8');
  await expect(page.getByRole('status')).toContainText('对阵', { timeout: 7000 });
  await page.getByRole('button', { name: '预览比赛画面', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放演示', exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="节目预览"]')).toHaveAttribute(
    'src',
    /\/program\?preview=1/,
  );
  await expect(
    page.frameLocator('iframe[title="节目预览"]').locator('.program-canvas'),
  ).toBeVisible();
  await expect(page.locator('.preparation-program-preview iframe')).toHaveCount(1);
  await page.waitForTimeout(6500);
  await expect(page.getByRole('button', { name: '比赛中', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(commands).toEqual([]);
});

test('reduced motion switches directly and keeps keyboard focus on the selected control', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/preview');
  const half = page.getByRole('button', { name: '半场', exact: true });
  await half.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.frameLocator('iframe[title="节目预览"]').locator('.summary-players'),
  ).toBeVisible();
  await expect(page.locator('.preparation-program-preview iframe')).toHaveCount(1);
  await expect(half).toBeFocused();
  expect(
    await page
      .locator('iframe[title="节目预览"]')
      .evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});
