import { expect, test } from './companion-isolation.js';

test('qualification help uses the shared product shell and development host diagnostics', async ({
  page,
}) => {
  await page.goto('/qualification');

  const topbar = page.locator('.product-topbar');
  await expect(page.getByRole('heading', { name: '现场验收', exact: true })).toBeVisible();
  await expect(topbar.getByRole('link', { name: '现场验收' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(topbar).toBeVisible();

  const response = await page.request.get('/debug/hosts');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toMatchObject({
    active: {
      obs: expect.any(Number),
      browser: expect.any(Number),
      unknown: expect.any(Number),
    },
    totals: {
      connected: expect.any(Number),
      disconnected: expect.any(Number),
    },
  });
});
