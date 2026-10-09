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
      /\/(?:local\/v1\/(?:tournament|match-document)|operator\/local-match\/(?:create|save)|operator\/local-event\/save)$/,
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
    await page.goto('/');
    const form = page.locator('.workspace-local-match form').first();
    await form.locator('input').nth(0).fill('甲队');
    await form.locator('input').nth(1).fill('乙队');
    await form.getByRole('button', { name: '创建本地比赛' }).click();
    await expect(page.getByRole('region', { name: '本场上下文' })).toContainText('甲队 vs 乙队');
    await page.getByRole('link', { name: '本场资料', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存比赛资料' })).toBeVisible();
    await page.getByLabel('阶段名称').fill('决赛');
    await page.getByRole('button', { name: '保存比赛资料' }).click();
    await expect(page.getByText('比赛资料已保存。', { exact: true })).toBeVisible();
    await page.goto('/resources?tab=event');
    await page.getByLabel('赛事名称').fill('验收赛事');
    await page.getByRole('button', { name: '保存赛事资料' }).click();
    await expect(page.getByText('赛事资料已保存。', { exact: true })).toBeVisible();
    await page.reload();
    await page.goto('/?tab=details');
    await expect(page.getByLabel('阶段名称')).toHaveValue('决赛');
    await page.goto('/resources?tab=event');
    await expect(page.getByLabel('赛事名称')).toHaveValue('验收赛事');
    await page.goto('/?select=1');
    await page.getByRole('button', { name: '沿用当前本地赛事 · 验收赛事' }).click();
    await form.getByLabel('队伍 A', { exact: true }).fill('丙队');
    await form.getByLabel('队伍 B', { exact: true }).fill('丁队');
    // A real service 409 must leave the creation draft and selected event intact.
    await page.route(
      '**/operator/local-match/create',
      (route) => route.fulfill({ status: 409, json: { message: '本场已变化，请重试。' } }),
      { times: 1 },
    );
    await form.getByRole('button', { name: '创建本地比赛' }).click();
    await expect(page.getByText('本场已变化，请重试。', { exact: true })).toBeVisible();
    await expect(form.getByLabel('队伍 A', { exact: true })).toHaveValue('丙队');
    await expect(form.getByLabel('创建比赛所属赛事')).not.toHaveValue('');
    if (process.env.MIZAR_REVIEW_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.MIZAR_REVIEW_SCREENSHOTS}/local-event-reuse-409.png`,
      });
    await form.getByRole('button', { name: '创建本地比赛' }).click();
    await expect(page.getByRole('region', { name: '本场上下文' })).toContainText('丙队 vs 丁队');
    const reused = (await app.inject('/local/v1/tournament')).json<{
      events: { eventId: string }[];
      matches: {
        competition: { competitionId: string; name: string };
        maps: unknown[];
        veto: unknown[];
        scoreA: number | null;
        scoreB: number | null;
      }[];
    }>();
    expect(reused.events).toHaveLength(1);
    expect(reused.matches).toHaveLength(2);
    expect(reused.matches[1]).toMatchObject({
      competition: { competitionId: reused.events[0]!.eventId, name: '验收赛事' },
      maps: [],
      veto: [],
      scoreA: null,
      scoreB: null,
    });
    const bp = await app.inject({ url: '/local/v1/bp-workspace' });
    expect(bp.json<{ readiness: string }>().readiness).toBe('missing');
    const original = await app.inject({ url: '/local/v1/tournament' });
    const resourceId = original.json<{ matches: { matchId: string }[] }>().matches[0]!.matchId;
    const next = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { teamA: '下一场甲', teamB: '下一场乙', format: 'bo5' },
    });
    expect(next.statusCode).toBe(200);
    await page.goto('/resources');
    await page.getByLabel('浏览比赛资源').selectOption(resourceId);
    await page.getByRole('link', { name: '赛事与赛程', exact: true }).click();
    expect(new URL(page.url()).searchParams.get('resource')).toBe(resourceId);
    await page.getByRole('link', { name: '比赛与队伍', exact: true }).click();
    await expect(page.getByLabel('浏览比赛资源')).toHaveValue(resourceId);
    const current = await app.inject({ url: '/local/v1/tournament' });
    expect(current.json<{ activeLocalMatchId: string }>().activeLocalMatchId).toBe(
      next.json<{ matchId: string }>().matchId,
    );
    await page.route(
      '**/operator/local-match/select',
      (route) => route.fulfill({ status: 409, json: { message: '载入未完成，保留当前选择。' } }),
      { times: 1 },
    );
    await page.getByRole('button', { name: '确认载入为本场' }).click();
    await expect(page.getByText('载入未完成，保留当前选择。', { exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/resources');
    await expect(page.getByLabel('浏览比赛资源')).toHaveValue(resourceId);
    // Selection succeeds through the existing service before navigation.
    await context.route('**/operator/local-match/select', async (route) => {
      const response = await app.inject({
        method: 'POST',
        url: '/operator/local-match/select',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: route.request().postDataJSON() as Record<string, unknown>,
      });
      await route.fulfill({
        status: response.statusCode,
        body: response.body,
        contentType: 'application/json',
      });
    });
    await page.getByRole('button', { name: '确认载入为本场' }).click();
    await expect(page).toHaveURL(/\/\?tab=details$/);
    await expect(page.getByLabel('阶段名称')).toHaveValue('决赛');
    await page.goto('/?tab=roster');
    await page.getByLabel('队名', { exact: true }).first().fill('甲队更新');
    await expect(
      page.getByText(
        '保存本场同时同步队伍库的队名、队标与名单；已有其他比赛快照不改写，今后复用使用更新后的队伍。',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: '保存比赛资料' }).click();
    await expect(page.getByText('比赛资料已保存。', { exact: true })).toBeVisible();
    const teams = (await app.inject('/local/v1/tournament')).json<{ teams: { name: string }[] }>()
      .teams;
    expect(teams.some((team) => team.name === '甲队更新')).toBe(true);
    await page.goto('/resources?tab=event');
    await page.getByLabel('赛事名称').fill('同赛事品牌更新');
    await page.getByRole('button', { name: '保存赛事资料' }).click();
    await expect(page.getByText('赛事资料已保存。', { exact: true })).toBeVisible();
    const matches = (await app.inject('/local/v1/tournament')).json<{
      matches: { competition: { name: string } }[];
    }>().matches;
    expect(matches.slice(0, 2).map((match) => match.competition.name)).toEqual([
      '同赛事品牌更新',
      '同赛事品牌更新',
    ]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
