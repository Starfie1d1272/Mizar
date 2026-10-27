import { expect, test } from './companion-isolation.js';

test('BP presentation choice persists and previews both real renderers', async ({
  page,
}, testInfo) => {
  let mode = 'full';
  let revision = 1;
  await page.route('**/local/v1/bp-presentation', (route) =>
    route.fulfill({ json: { mode, revision: String(revision) } }),
  );
  await page.route('**/operator/bp-presentation', async (route) => {
    const body = route.request().postDataJSON() as { mode: string; expectedRevision: string };
    expect(body.expectedRevision).toBe(String(revision));
    mode = body.mode;
    revision++;
    await route.fulfill({ json: { mode, revision: String(revision) } });
  });
  await page.goto('/settings?tab=obs');
  const full = page.getByRole('radio', { name: '全屏 BP' });
  const compact = page.getByRole('radio', { name: '游戏画面 + BP 底栏' });
  await expect(full).toBeChecked();
  await expect(page.locator('.bp-presentation-preview')).toHaveCount(2);
  await compact.click();
  await expect(compact).toBeChecked();
  await page.reload();
  await expect(compact).toBeChecked();
  await page
    .locator('.bp-presentation-settings')
    .screenshot({ path: testInfo.outputPath('bp-preference-settings.png') });
  await full.click();
  await expect(full).toBeChecked();
});
