import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

test('task workspaces use real local data and keep candidate browsing separate from production', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-task-review-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'tournament.json'),
  });
  let unavailableMatch = false;
  let unavailableTournament = false;
  const productionWrites: string[] = [];
  const matchSelectionWrites: string[] = [];
  const evidence = process.env.MIZAR_REVIEW_SCREENSHOTS;
  try {
    await app.ready();
    await context.route(
      /\/(?:local\/v1\/|operator\/local-|operator\/bp-local-save|operator\/hud-config|operator\/production)/,
      async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (
          (unavailableMatch && pathname === '/local/v1/match-document') ||
          (unavailableTournament && pathname === '/local/v1/tournament')
        ) {
          await route.fulfill({ status: 503, json: { error: 'temporary_read_failure' } });
          return;
        }
        if (request.method() === 'POST' && pathname === '/operator/local-match/select')
          matchSelectionWrites.push(pathname);
        if (request.method() === 'POST' && pathname === '/operator/production')
          productionWrites.push(pathname);
        const response = await app.inject({
          method: request.method() as 'GET' | 'POST',
          url: new URL(request.url()).pathname,
          headers: { ...request.headers(), origin: 'http://127.0.0.1:3000' },
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
    await page.goto('/?createLocal=1');
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, 'empty-match.png') });
    }
    await page.getByLabel('队伍 A', { exact: true }).fill('星火国际电子竞技俱乐部 Alpha');
    await page.getByLabel('队伍 B', { exact: true }).fill('北极星青年竞技俱乐部 Bravo');
    await page.getByRole('button', { name: '创建本地比赛', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeVisible();
    for (let side = 0; side < 2; side++) {
      const team = page.locator('.preparation-editor fieldset').nth(side);
      await team.getByText('手动编辑名单', { exact: true }).click();
      for (let player = 0; player < 5; player++) {
        await team.getByRole('button', { name: '添加选手', exact: true }).click();
        await team
          .getByLabel('选手名称', { exact: true })
          .nth(player)
          .fill(`首发选手 ${side + 1}—${player + 1}`);
      }
    }

    await page.evaluate(() => window.dispatchEvent(new Event('mizar-enter')));
    await expect(page.getByRole('alert')).toContainText('请先保存资料再进入现场');
    expect(productionWrites).toEqual([]);
    unavailableMatch = true;
    unavailableTournament = true;
    await expect(
      page.getByText('赛事读取失败，保留最近资料与草稿；连接恢复并核对前禁止保存或载入。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeDisabled();
    await expect(page.getByLabel('选手名称', { exact: true })).toHaveCount(10);
    await expect(page.getByLabel('选手名称', { exact: true }).first()).toHaveValue('首发选手 1—1');
    if (evidence)
      await page.screenshot({ path: join(evidence, 'match-stale-draft.png'), fullPage: true });
    unavailableMatch = false;
    unavailableTournament = false;
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存比赛资料', exact: true }).click();
    await expect(page.getByText('比赛资料已保存。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '准备正式 BP', exact: true }).click();
    await page.getByRole('button', { name: '编辑本地 BP', exact: true }).click();
    const sequence = page.locator('.bp-sequence-step select');
    for (let index = 0; index < (await sequence.count()); index++) {
      const select = sequence.nth(index);
      const value = await select
        .locator('option:not([disabled])')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).find(Boolean),
        );
      expect(value).toBeTruthy();
      await select.selectOption(value!);
    }
    await page.getByRole('button', { name: '保存本地 BP', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存本地 BP', exact: true })).toHaveCount(0);
    const beforeMatchSave = (await app.inject('/local/v1/tournament')).json<{
      matches: { veto: unknown[]; maps: unknown[] }[];
    }>().matches[0]!;
    expect(beforeMatchSave.veto.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: '返回本场准备', exact: true }).click();
    await expect(page.getByText(/^地图计划与已保存禁选/)).toContainText('3 张图');
    await page.getByText(/^场次信息 ·/).click();
    await page.getByLabel('阶段名称').fill('决赛');
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存比赛资料', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await app.inject('/local/v1/tournament')).json<{ matches: { stageLabel: string }[] }>()
            .matches[0]?.stageLabel,
      )
      .toBe('决赛');
    const afterMatchSave = (await app.inject('/local/v1/tournament')).json<{
      matches: { veto: unknown[]; maps: unknown[] }[];
    }>().matches[0]!;
    expect(afterMatchSave.veto).toEqual(beforeMatchSave.veto);
    expect(afterMatchSave.maps).toEqual(beforeMatchSave.maps);

    await page.goto('/resources?tab=event');
    await page.getByLabel('赛事名称', { exact: true }).fill('断线保留赛事草稿');
    unavailableTournament = true;
    await expect(
      page.getByText('赛事读取失败，保留最近资料与草稿；连接恢复并核对前禁止保存或载入。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel('赛事名称', { exact: true })).toHaveValue('断线保留赛事草稿');
    await expect(page.getByRole('button', { name: '保存赛事资料', exact: true })).toBeDisabled();
    if (evidence)
      await page.screenshot({ path: join(evidence, 'event-stale-draft.png'), fullPage: true });
    unavailableTournament = false;
    await expect(page.getByRole('button', { name: '保存赛事资料', exact: true })).toBeEnabled();
    await expect(page.getByLabel('赛事名称', { exact: true })).toHaveValue('断线保留赛事草稿');
    await page.getByRole('button', { name: '保存赛事资料', exact: true }).click();
    await expect(page.getByText('赛事资料已保存。', { exact: true })).toBeVisible();
    await page.reload();
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const scale of [100, 125, 150]) {
      await page.setViewportSize({
        width: Math.round((1920 * 100) / scale),
        height: Math.round((1032 * 100) / scale),
      });
      for (const [name, url] of [
        ['match', '/'],
        ['picture', '/?tab=picture'],
        ['check', '/?tab=check'],
        ['events', '/resources?tab=event'],
        ['hud-resources', '/resources?tab=hud'],
        ['settings', '/settings?tab=obs'],
      ] as const) {
        await page.goto(url);
        await expect(page.locator('main.production-page')).toBeVisible();
        if (name === 'match')
          await expect(page.locator('.preparation-editor fieldset').first()).toContainText(
            '首发选手 1—5',
          );
        if (name === 'check')
          await expect(page.locator('.spectator-workflow li').nth(2)).toContainText(
            '进入制播工作区',
          );
        if (name === 'picture') {
          await expect(page.getByTitle('节目预览', { exact: true })).toHaveAttribute(
            'src',
            '/program/waiting',
          );
          await expect(
            page.frameLocator('iframe[title="节目预览"]').locator('.program-scene--waiting'),
          ).toBeVisible();
        }
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        if (evidence)
          await page.screenshot({ path: join(evidence, `${name}-${scale}.png`), fullPage: true });
      }
    }
    await page.goto('/resources');
    await expect(page.getByRole('button', { name: '确认载入为本场', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '前往本场准备', exact: true }).click();
    await expect(page).toHaveURL(/\/\?tab=match$/);
    expect(matchSelectionWrites).toEqual([]);
    const firstState = (await app.inject('/local/v1/tournament')).json<{
      events: { eventId: string; matchIds: string[] }[];
    }>();
    const event = firstState.events[0]!;
    const second = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        teamA: '下一场 Alpha',
        teamB: '下一场 Charlie',
        eventId: event.eventId,
        format: 'bo3',
      },
    });
    expect(second.statusCode).toBe(200);
    await page.goto('/resources?tab=event');
    const schedule = page.getByLabel('本赛事赛程').getByRole('button');
    await expect(schedule.first()).toContainText('星火国际电子竞技俱乐部 Alpha');
    await page.getByRole('button', { name: '上移', exact: true }).nth(1).click();
    await expect(schedule.first()).toContainText('下一场 Alpha');
    await expect(schedule.nth(1)).toContainText('星火国际电子竞技俱乐部 Alpha');
    await page.reload();
    await expect(schedule.first()).toContainText('下一场 Alpha');
    const activeBefore = (await app.inject('/local/v1/tournament')).json<{
      activeLocalMatchId: string;
    }>().activeLocalMatchId;
    await page.getByRole('button', { name: /星火国际电子竞技俱乐部 Alpha vs/ }).click();
    expect(
      (await app.inject('/local/v1/tournament')).json<{ activeLocalMatchId: string }>()
        .activeLocalMatchId,
    ).toBe(activeBefore);
    await page.goto('/?tab=maps');
    await expect(page.getByRole('region', { name: '正式 BP 子任务' })).toBeVisible();
    await page.getByRole('button', { name: '返回本场准备', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
