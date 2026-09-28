import { expect, test } from './companion-isolation.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';

test('Workspace preview shares the scene registry and sends a revisioned command', async ({
  page,
}) => {
  let command: unknown;
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'waiting',
        revision: 'revision-1',
        available: PROGRAM_SCENES.map((scene) => scene.id),
        blocked: {},
      },
    }),
  );
  await page.route('**/operator/program-scene', async (route) => {
    command = route.request().postDataJSON() as unknown;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await expect(page.getByText('真实 CS2 窗口预留区域')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).toBeVisible();
  await expect(page.getByRole('main', { name: '现场控制底栏' })).toBeVisible();
  for (const scene of PROGRAM_SCENES)
    await expect(page.getByRole('button', { name: scene.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect.poll(() => command).toEqual({ sceneId: 'matchup', expectedRevision: 'revision-1' });

  await page.goto('/settings?tab=obs');
  await page.getByText('高级连接设置', { exact: true }).click();
  await expect(page.getByLabel('WebSocket 密码')).toBeVisible();
});

test('every Program Scene route renders without match data', async ({ page }) => {
  for (const scene of PROGRAM_SCENES.filter((item) => item.id !== 'gameplay' && item.id !== 'bp')) {
    await page.goto(scene.path);
    await expect(page.locator(`.program-scene--${scene.id}`)).toBeVisible();
    if (scene.id === 'waiting')
      await expect(page.getByRole('heading', { name: scene.title, exact: true })).toBeVisible();
    else await expect(page.locator('.program-scene__content')).toHaveCount(0);
  }
});
