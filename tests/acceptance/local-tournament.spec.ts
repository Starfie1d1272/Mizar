import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

test('Preparation flow creates and edits a local match before BP', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-ui-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'tournament.json'),
  });
  try {
    await app.ready();
    await context.route(
      /\/(?:local\/v1\/(?:tournament|match-document)|operator\/local-match\/(?:create|save|select|[^/]+\/save)|operator\/local-event\/save)$/,
      async (route) => {
        const request = route.request();
        const response = await app.inject({
          method: request.method() as 'GET' | 'POST',
          url: new URL(request.url()).pathname,
          headers: request.headers(),
          ...(request.postData() === null ? {} : { payload: request.postData()! }),
        });
        await route.fulfill({
          status: response.statusCode,
          body: response.body,
          contentType: String(response.headers['content-type'] ?? 'application/json'),
        });
      },
    );
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto('/matches');
    const form = page.locator('.workspace-local-match form').first();
    await form.locator('input').nth(0).fill('甲队');
    await form.locator('input').nth(1).fill('乙队');
    await form.getByRole('button', { name: '创建本地比赛' }).click();
    await expect(page.locator('.workspace-local-match select').last()).toContainText(
      '甲队 vs 乙队',
    );
    await page.getByText('编辑比赛资料', { exact: true }).click();
    await expect(page.getByRole('button', { name: '保存比赛资料' })).toBeVisible();
    await page.getByLabel('阶段名称').fill('决赛');
    await page.getByRole('button', { name: '保存比赛资料' }).click();
    await expect(page.getByRole('status').filter({ hasText: '比赛资料已保存。' })).toBeVisible();
    await page.goto('/resources');
    await page.getByRole('button', { name: '编辑赛事品牌与默认规则' }).click();
    await page.getByLabel('赛事名称').fill('验收赛事');
    await page.getByRole('button', { name: '保存赛事资料' }).click();
    await expect(page.getByRole('status').filter({ hasText: '赛事资料已保存。' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '编辑赛事品牌与默认规则' }).click();
    await expect(page.getByLabel('赛事名称')).toHaveValue('验收赛事');
    await page.goto('/matches');
    await page.getByText('编辑比赛资料', { exact: true }).click();
    await expect(page.getByLabel('阶段名称')).toHaveValue('决赛');
    const bp = await app.inject({ url: '/local/v1/bp-workspace' });
    expect(bp.json<{ readiness: string }>().readiness).toBe('missing');
    const before = (await app.inject('/local/v1/tournament')).json<{
      activeLocalMatchId: string;
      matches: { matchId: string; stageLabel: string }[];
    }>();
    const created = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { teamA: '丙队', teamB: '丁队', format: 'bo3' },
    });
    expect(created.statusCode).toBe(200);
    const activeId = created.json<{ matchId: string }>().matchId;
    await page.goto(`/resources?resource=${before.activeLocalMatchId}`);
    await expect(page.getByText('候选比赛', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑比赛', exact: true }).click();
    await page.locator('.match-meta-edit > summary').click();
    await page.getByLabel('阶段名称').fill('候选场次修订');
    await page.getByRole('button', { name: '保存比赛资料', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '比赛资料已保存。' })).toBeVisible();
    const after = (await app.inject('/local/v1/tournament')).json<typeof before>();
    expect(after.activeLocalMatchId).toBe(activeId);
    expect(
      after.matches.find((match) => match.matchId === before.activeLocalMatchId)?.stageLabel,
    ).toBe('候选场次修订');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
