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
  await expect(page.getByText('CS2 游戏画面')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).toBeVisible();
  await expect(page.getByRole('main', { name: '现场控制底栏' })).toBeVisible();
  for (const scene of PROGRAM_SCENES)
    await expect(page.getByRole('button', { name: scene.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect.poll(() => command).toEqual({ sceneId: 'matchup', expectedRevision: 'revision-1' });

  await page.goto('/settings?tab=obs');
  await expect(page.getByRole('button', { name: '编辑连接', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('WebSocket 密码')).toBeVisible();
  await expect(page.getByRole('heading', { name: '连接控制', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并测试', exact: true })).toBeVisible();
});

test('every Program Scene route renders without match data', async ({ page }) => {
  for (const scene of PROGRAM_SCENES.filter((item) => item.id !== 'gameplay' && item.id !== 'bp')) {
    await page.goto(scene.path);
    await expect(page.locator(`.program-scene--${scene.id}`)).toBeVisible();
    if (scene.id === 'waiting')
      await expect(
        page.getByRole('heading', { name: 'BROADCAST STARTING SOON', exact: true }),
      ).toBeVisible();
    else await expect(page.locator(`.program-scene--${scene.id}`)).toBeEmpty();
  }
});

test('all scene controls stay visible and manual takeover can resume', async ({ page }) => {
  let mode = 'auto';
  let revision = 'auto-1';
  const commands: unknown[] = [];
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: mode === 'manual' ? 'matchup' : 'waiting',
        revision,
        available: PROGRAM_SCENES.map((s) => s.id),
        blocked: {},
        director: {
          mode,
          next: 'gameplay',
          reason: null,
          introDurationMs: 3000,
          sceneElapsedMs: 0,
        },
      },
    }),
  );
  await page.route('**/operator/program-scene', async (route) => {
    commands.push(route.request().postDataJSON());
    mode = 'manual';
    revision = 'manual-2';
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/operator/program-director', async (route) => {
    commands.push(route.request().postDataJSON());
    mode = 'auto';
    revision = 'auto-3';
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await expect(page.getByText('自动编排', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '对阵', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'BP 控制', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '正式 BP', exact: true })).toHaveCount(1);
  expect(commands).toEqual([]);
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect(page.getByText('手动保持', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '恢复自动', exact: true }).click();
  await expect(page.getByRole('button', { name: '对阵', exact: true })).toBeVisible();
  expect(commands).toEqual([
    { sceneId: 'matchup', expectedRevision: 'auto-1' },
    { action: 'resume', expectedRevision: 'manual-2' },
  ]);
});
