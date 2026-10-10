import { expect, test } from './companion-isolation.js';

test('qualification help uses the preparation shell and development host diagnostics', async ({
  page,
}) => {
  await page.goto('/qualification');

  const sidebar = page.locator('.product-sidebar');
  await expect(page.getByRole('heading', { name: '现场验收', exact: true })).toBeVisible();
  await expect(sidebar).toBeVisible();
  const nav = sidebar.getByRole('navigation', { name: '制作导航' });
  await expect(nav.getByRole('link', { name: '本场' })).toHaveAttribute('href', '/');
  await expect(nav.getByRole('link', { name: '比赛库', exact: true })).toHaveAttribute(
    'href',
    '/resources',
  );
  await expect(nav.getByRole('link', { name: 'HUD', exact: true })).toHaveAttribute(
    'href',
    '/resources?tab=hud',
  );
  await expect(page.getByRole('link', { name: '返回本场制播' })).toHaveAttribute('href', '/');

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
