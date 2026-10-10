import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceStore } from '../../apps/companion/src/resource-store/store.js';
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
    resources: { root: join(directory, 'assets') },
  });
  let unavailableMatch = false;
  let unavailableTournament = false;
  const productionWrites: string[] = [];
  const matchSelectionWrites: string[] = [];
  const evidence = process.env.MIZAR_REVIEW_SCREENSHOTS;
  const pressure = process.env.MIZAR_REVIEW_STRESS === '1';
  const teamA = pressure ? '星火国际电子竞技俱乐部 Alpha' : '启明大学';
  const teamB = pressure ? '北极星青年竞技俱乐部 Bravo' : '星海学院';
  const eventName = pressure ? '断线保留赛事草稿' : '校园联赛';
  const playerName = (side: number, player: number) =>
    pressure
      ? `首发选手 ${side + 1}—${player + 1}`
      : ['林间', '回声', '光年', '望川', '远山', '星尘', '晨曦', '北辰', '清风', '飞羽'][
          side * 5 + player
        ]!;
  const journey: {
    file: string;
    clicks: string;
    result: string;
    viewport: { width: number; height: number } | null;
  }[] = [];
  async function expectActionInWindow(name: string) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  async function capture(file: string, clicks: string, result: string) {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document
        .querySelectorAll('main.production-page > section, .event-match-detail')
        .forEach((element) => {
          element.scrollTop = 0;
        });
    });
    await page.screenshot({ path: join(evidence, `${file}.png`), fullPage: false });
    journey.push({ file: `${file}.png`, clicks, result, viewport: page.viewportSize() });
    await writeFile(join(evidence, 'journey.json'), JSON.stringify(journey, null, 2));
  }
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
          headers: response.headers as Record<string, string>,
          body: response.body,
          contentType: String(response.headers['content-type'] ?? 'application/json'),
        });
      },
    );
    page.on('dialog', (dialog) => dialog.accept());
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/?createLocal=1');
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await capture('01-create-match', '制播 → 新建本地比赛', '空场只显示选择 / 新建本场任务');
    }
    await page.getByLabel('队伍 A', { exact: true }).fill(teamA);
    await page.getByLabel('队伍 B', { exact: true }).fill(teamB);
    await page.getByRole('button', { name: '创建本地比赛', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeVisible();
    for (let side = 0; side < 2; side++) {
      const team = page.locator('.preparation-editor fieldset').nth(side);
      for (let player = 0; player < 5; player++) {
        await team.getByRole('button', { name: '添加选手', exact: true }).click();
        await team
          .getByLabel('选手名称', { exact: true })
          .nth(player)
          .fill(playerName(side, player));
      }
    }

    await expectActionInWindow('保存比赛资料');
    await capture(
      '02-roster-edit',
      '创建本地比赛 → 手动编辑双方名单 → 各添加五位首发',
      '双方编辑并列，保存操作留在窗口内',
    );
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
    await expect(page.getByLabel('选手名称', { exact: true }).first()).toHaveValue(
      playerName(0, 0),
    );
    await capture(
      '03-offline-draft',
      '读取故障注入 → 核对本场草稿',
      '十人输入保留，保存禁用；这是明确的故障注入',
    );
    unavailableMatch = false;
    unavailableTournament = false;
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存比赛资料', exact: true }).click();
    await expect(page.getByText('比赛资料已保存。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '准备正式 BP', exact: true }).click();
    await page.getByRole('button', { name: '编辑本地 BP', exact: true }).click();
    await capture(
      '04-bp-edit',
      '保存比赛资料 → 准备正式 BP → 编辑本地 BP',
      '进入现有正式 BP 编辑工作面',
    );
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
    await capture('05-bp-saved', '依次选择地图 → 保存本地 BP', '禁选和地图经真实服务保存');
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
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeEnabled();

    await expectActionInWindow('保存比赛资料');
    await capture(
      '06-match-details',
      '返回本场准备 → 场次信息 → 填写阶段 → 保存比赛资料',
      '本场信息保存，已保存 BP 和地图保持',
    );
    await page.getByText(/^场次信息 ·/).click();
    await expect(page.getByLabel('选手名称', { exact: true }).first()).toHaveValue(
      playerName(0, 0),
    );
    await page.goto('/resources?tab=event');
    await page.getByLabel('赛事名称', { exact: true }).fill(eventName);
    unavailableTournament = true;
    await expect(
      page.getByText('赛事读取失败，保留最近资料与草稿；连接恢复并核对前禁止保存或载入。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel('赛事名称', { exact: true })).toHaveValue(eventName);
    await expect(page.getByRole('button', { name: '保存赛事资料', exact: true })).toBeDisabled();
    await capture(
      '07-event-offline',
      '资源 → 编辑赛事品牌与默认规则 → 修改名称 → 读取故障注入',
      '编辑替代详情，草稿保留并禁止保存',
    );
    unavailableTournament = false;
    await expect(page.getByRole('button', { name: '保存赛事资料', exact: true })).toBeEnabled();
    await expect(page.getByLabel('赛事名称', { exact: true })).toHaveValue(eventName);
    await page.getByRole('button', { name: '保存赛事资料', exact: true }).click();
    await expect(page.getByText('赛事资料已保存。', { exact: true })).toBeVisible();
    await expectActionInWindow('保存赛事资料');
    await expectActionInWindow('取消编辑');
    await capture(
      '08-event-edit',
      '恢复连接 → 保存赛事资料',
      '名称 / 品牌 / 地图池 / BO3 规则与保存、取消处于同一工作面',
    );
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await capture('09-event-details', '取消编辑 → 返回比赛详情', '左侧赛程不变，右侧恢复候选详情');
    await page.reload();
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const [scale, width, height] of [
      [100, 1920, 1080],
      [125, 1536, 864],
      [150, 1280, 720],
      ['1440p', 2560, 1440],
    ] as const) {
      await page.setViewportSize({ width, height });
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
          await expect(
            page.locator('.preparation-editor fieldset').first().getByLabel('选手名称').nth(4),
          ).toHaveValue(playerName(0, 4));
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
          await page.screenshot({ path: join(evidence, `${name}-${scale}.png`), fullPage: false });
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
    await page.goto('/resources');
    await page.getByRole('button', { name: '在此赛事追加下一场', exact: true }).click();
    await page.getByLabel('队伍 A', { exact: true }).fill(teamA);
    await page.getByRole('button', { name: `复用 ${teamA}`, exact: true }).click();
    await page.getByLabel('队伍 B', { exact: true }).fill('远航学院');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expectActionInWindow('创建本地比赛');
    await capture(
      '10-second-match-create',
      '在此赛事追加下一场 → 输入队伍 A → 复用已保存队伍 → 填队伍 B',
      '赛事 / 双方 / 赛制与提交按语义对齐，不叠加旧详情',
    );
    await page.getByRole('button', { name: '创建本地比赛', exact: true }).click();
    await expect(page).toHaveURL(/\/\?tab=match$/);
    const secondState = (await app.inject('/local/v1/tournament')).json<{
      matches: {
        competition: { competitionId: string };
        entrants: { a: { players: unknown[] } };
      }[];
    }>();
    expect(secondState.matches).toHaveLength(2);
    expect(secondState.matches[1]!.competition.competitionId).toBe(event.eventId);
    expect(secondState.matches[1]!.entrants.a.players).toEqual(
      secondState.matches[0]!.entrants.a.players,
    );
    await page.goto('/resources?tab=event');
    const schedule = page.getByLabel('本赛事赛程').getByRole('button');
    await expect(schedule.first()).toContainText(teamB);
    await capture(
      '10-second-match',
      '通过真实赛事服务追加第二场 → 资源赛事赛程',
      '同赛事品牌 / 默认规则复用，候选尚未切换',
    );
    await page.getByRole('button', { name: '上移', exact: true }).nth(1).click();
    await expect(schedule.first()).toContainText('远航学院');
    await expect(schedule.nth(1)).toContainText(teamB);
    await page.reload();
    await expect(schedule.first()).toContainText('远航学院');
    const activeBefore = (await app.inject('/local/v1/tournament')).json<{
      activeLocalMatchId: string;
    }>().activeLocalMatchId;
    await page.getByRole('button', { name: new RegExp(`${teamA} vs ${teamB}`) }).click();
    expect(
      (await app.inject('/local/v1/tournament')).json<{ activeLocalMatchId: string }>()
        .activeLocalMatchId,
    ).toBe(activeBefore);
    const activeDocumentBeforeEdit = (await app.inject('/local/v1/match-document')).body;
    await page.getByRole('button', { name: '编辑比赛', exact: true }).click();
    await page.getByText(/^场次信息 ·/).click();
    await page.getByLabel('阶段名称', { exact: true }).fill('候选场次修订');
    await expectActionInWindow('保存比赛资料');
    await capture(
      '10-candidate-edit',
      '浏览候选 → 编辑比赛 → 修改场次',
      '按比赛 ID 编辑，未载入本场',
    );
    await page.getByRole('button', { name: '保存比赛资料', exact: true }).click();
    await expect(page.getByText('比赛资料已保存。', { exact: true })).toBeVisible();
    const candidateAfterEdit = (await app.inject('/local/v1/tournament')).json<{
      activeLocalMatchId: string;
      matches: { stageLabel: string; entrants: { b: { name: string } } }[];
    }>();
    expect(candidateAfterEdit.activeLocalMatchId).toBe(activeBefore);
    expect(
      candidateAfterEdit.matches.find((item) => item.entrants.b.name === teamB)?.stageLabel,
    ).toBe('候选场次修订');
    expect((await app.inject('/local/v1/match-document')).body).toBe(activeDocumentBeforeEdit);
    expect(matchSelectionWrites).toEqual([]);
    await page.getByLabel('阶段名称', { exact: true }).fill('候选场次再次修订');
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存比赛资料', exact: true }).click();
    await expect
      .poll(async () => {
        const state = (await app.inject('/local/v1/tournament')).json<{
          matches: { stageLabel: string; entrants: { b: { name: string } } }[];
        }>();
        return state.matches.find((item) => item.entrants.b.name === teamB)?.stageLabel;
      })
      .toBe('候选场次再次修订');
    expect((await app.inject('/local/v1/match-document')).body).toBe(activeDocumentBeforeEdit);
    expect(matchSelectionWrites).toEqual([]);
    await page.goto('/?tab=maps');
    await expect(page.getByRole('region', { name: '正式 BP 子任务' })).toBeVisible();
    await page.getByRole('button', { name: '返回本场准备', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存比赛资料', exact: true })).toBeVisible();
    await page.goto('/resources?tab=hud');
    await page.getByText('官方演练素材', { exact: true }).click();
    await expect(page.getByLabel('官方素材缓存状态')).toContainText('独立缓存未准备');
    const resourceStore = app.getDecorator<() => ResourceStore>('getResourceStore')();
    await expect(
      resourceStore.installVerified('official:epl-default', () => Promise.resolve({})),
    ).rejects.toThrow('resource_policy_unavailable');
    await page.getByRole('button', { name: '重新读取素材状态', exact: true }).click();
    await expect(page.getByLabel('官方素材缓存状态')).toContainText('素材处理失败');
    await capture(
      '11-resource-store-rejection',
      '资源 → 官方演练素材 → 缺少授权策略的实际 Store 拒绝 → 重新读取',
      '同一真实 Store 查询失败，不新建下载器；原 Full 路径保留，这不是正式签名正例',
    );
    await page.getByText('官方演练素材', { exact: true }).click();
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: '编辑 Mizar 默认预设', exact: true }).click();
    const editor = await popupPromise;
    await editor.waitForURL(/\/operator\/hud/);
    const editorUrl = new URL(editor.url());
    // The dev fixture host defaults this tool to sample authoring; exercise the real service.
    editorUrl.searchParams.set('hud-config', 'companion');
    await editor.goto(editorUrl.href);
    await expect(editor.getByRole('region', { name: '编辑与正式播出版本' })).toContainText(
      '已保存',
    );
    await editor.getByRole('button', { name: '预设', exact: true }).click();
    await editor.getByLabel('名称', { exact: true }).fill('校园联赛预设');
    await editor.getByRole('button', { name: '另存为', exact: true }).click();
    await expect(editor.getByText('已另存为「校园联赛预设」。', { exact: true })).toBeVisible();
    if (evidence)
      await editor.screenshot({ path: join(evidence, '11-hud-edit-saved.png'), fullPage: false });
    await editor.getByRole('button', { name: '启用当前预设', exact: true }).click();
    await expect(editor.getByText('当前预设已启用。', { exact: true })).toBeVisible();
    if (evidence)
      await editor.screenshot({ path: join(evidence, '12-hud-activated.png'), fullPage: false });
    if (evidence) {
      for (const [scale, width, height] of [
        [125, 1536, 864],
        [150, 1280, 720],
      ] as const) {
        await editor.setViewportSize({ width, height });
        await editor.screenshot({
          path: join(evidence, `hud-editor-${scale}.png`),
          fullPage: false,
        });
      }
    }
    await editor.close();
    await page.goto('/?tab=picture');
    await expect(page.getByText('所选预设已正式启用。', { exact: true })).toBeVisible();
    await expect(
      page.frameLocator('iframe[title="节目预览"]').locator('.program-scene--waiting'),
    ).toBeVisible();
    await expectActionInWindow('打开独立节目预览');
    await capture(
      '13-picture-check',
      'HUD 另存为 → 明确启用 → 返回画面检查',
      '读取真实已启用配置；当前数据等待观战，不冒充游戏运行',
    );
    await page.goto('/?tab=check');
    await page.getByRole('button', { name: '进入制播工作区', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?tab=obs&prepare=1$/);
    await expect(page.getByRole('button', { name: '打开 OBS', exact: true })).toBeVisible();
    await capture(
      '14-obs-required',
      '开播检查 → 进入制播工作区',
      '真实 OBS 未连接，安全门槛引导连接与检查；未绕过进入现场',
    );
    await page.goto('/?tab=finish');
    await page.getByRole('button', { name: '结束制播 / 重试收尾', exact: true }).click();
    await expect(page.getByLabel('Companion 清理回执')).toContainText('收起节目 · 已确认');
    await expect(page.getByLabel('Companion 清理回执')).toContainText('释放网站数据源 · 已确认');
    await capture(
      '15-finish-receipt',
      '更多操作 → 恢复与收尾 → 结束本场制播 → 确认',
      '节目已处于 waiting，真实 Companion 分项收尾确认；浏览器不能验收 Host 游戏与配置',
    );
  } finally {
    try {
      await context.unrouteAll({ behavior: 'wait' });
    } finally {
      try {
        await app.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
