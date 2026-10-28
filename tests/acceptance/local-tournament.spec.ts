import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MatchDocumentV1 } from '../../packages/protocol/src/context.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';
import websiteSchedule from '../../apps/web/src/patterns/library-schedule.fixture.json' with { type: 'json' };

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

test('local and website libraries share match details while browsing and loading stay separate', async ({
  page,
  context,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-shared-library-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'tournament.json'),
  });
  const selections: string[] = [];
  const detailReads: string[] = [];
  let refreshes = 0;
  let cacheMissing = false;
  try {
    await app.ready();
    let eventId: string | undefined;
    for (const [teamA, teamB] of [
      ['甲队', '乙队'],
      ['丙队', '丁队'],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/operator/local-match/create',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {
          teamA,
          teamB,
          format: 'bo3',
          ...(eventId ? { eventId } : { eventName: '统一布局邀请赛' }),
        },
      });
      expect(response.statusCode).toBe(200);
      eventId = (await app.inject('/local/v1/tournament')).json<{ events: { eventId: string }[] }>()
        .events[0]!.eventId;
    }
    const library = (await app.inject('/local/v1/tournament')).json<{
      matches: MatchDocumentV1[];
      activeLocalMatchId: string | null;
    }>();
    const first = library.matches[0]!;
    const second = library.matches[1]!;
    await context.route(
      (url) => url.pathname.startsWith('/local/v1/') || url.pathname.startsWith('/operator/'),
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/local/v1/rivalhub-connection')
          return route.fulfill({
            json: {
              paired: true,
              displayName: '验收授权',
              activeMatchId: null,
              activeSourceMatchId: null,
            },
          });
        if (path.startsWith('/local/v1/rivalhub-library/')) {
          const id = decodeURIComponent(path.split('/').at(-1)!);
          detailReads.push(id);
          // Isolated network latency: the schedule heading may paint before details arrive.
          await new Promise((resolve) => setTimeout(resolve, 150));
          const document = library.matches.find((row) => row.matchId === id);
          return route.fulfill({
            json: {
              entry: document
                ? { document, checkedAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }
                : null,
              error: cacheMissing
                ? '网站暂时无法连接，显示上次浏览的资料；载入前会重新核对。'
                : null,
            },
          });
        }
        if (path === '/local/v1/rivalhub-schedule') {
          refreshes++;
          return route.fulfill({
            json: {
              competition: { name: first.competition?.name ?? '邀请赛' },
              viewer: { userId: 'fixture-viewer', displayName: '解说账号' },
              matches: library.matches.map((document, index) => ({
                status: (cacheMissing ? index === 1 : index === 0) ? 'in_progress' : 'scheduled',
                matchId: document.matchId,
                assignedToViewer: index === 0,
                scheduledAt: document.scheduledAt,
                format: document.format,
                stageLabel: document.stageLabel,
                entrantA: document.entrants.a,
                entrantB: document.entrants.b,
              })),
              library: {
                entries: {},
                syncedAt: '2026-10-19T00:00:00Z',
                error: null,
                refreshing: false,
              },
            },
          });
        }
        if (path === '/operator/rivalhub/select') {
          expect(request.postDataJSON()).toMatchObject({ activate: true });
          selections.push((request.postDataJSON() as { matchId: string }).matchId);
          return route.fulfill({ json: { ok: true } });
        }
        const response = await app.inject({
          method: request.method() as 'GET' | 'POST',
          url: path,
          headers: request.headers(),
          ...(request.postData() ? { payload: request.postData()! } : {}),
        });
        return route.fulfill({
          status: response.statusCode,
          body: response.body,
          contentType: String(response.headers['content-type'] ?? 'application/json'),
        });
      },
    );
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
      if (process.env.MIZAR_LIBRARY_SCREENSHOTS) {
        const { mkdir, copyFile } = await import('node:fs/promises');
        await mkdir(process.env.MIZAR_LIBRARY_SCREENSHOTS, { recursive: true });
        await copyFile(
          testInfo.outputPath(`${name}.png`),
          join(process.env.MIZAR_LIBRARY_SCREENSHOTS, `${name}.png`),
        );
      }
    };
    await page.goto(`/resources?resource=${first.matchId}`);
    const browser = page.getByRole('region', { name: '赛事与场次', exact: true });
    const detail = page.getByRole('region', { name: '比赛详情', exact: true });
    await expect(detail.getByRole('heading', { name: '甲队 vs 乙队', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '确认载入为本场' })).toBeVisible();
    const localText = await detail.locator('.library-detail-body').innerText();
    await capture('01-local');
    expect(detailReads).toEqual([]);
    await page.getByRole('button', { name: 'RivalHub 赛事', exact: true }).click();
    await expect(detail.getByRole('heading', { name: '甲队 vs 乙队', exact: true })).toBeVisible();
    await expect.poll(() => detail.locator('.library-detail-body').innerText()).toBe(localText);
    await expect(detail.getByRole('button', { name: '编辑比赛', exact: true })).toHaveCount(0);
    expect(detailReads).toEqual([first.matchId]);
    await expect(page.getByText('授权账号：解说账号', { exact: true })).toBeVisible();
    await expect(browser.getByRole('button', { name: /甲队 vs 乙队/ })).toContainText('我认领的');
    await capture('02-website');
    await browser.getByRole('button', { name: /丙队 vs 丁队/ }).click();
    await expect(detail.getByRole('heading', { name: '丙队 vs 丁队', exact: true })).toBeVisible();
    expect(selections).toEqual([]);
    await expect.poll(() => detailReads).toEqual([first.matchId, second.matchId]);
    expect(
      (await app.inject('/local/v1/tournament')).json<typeof library>().activeLocalMatchId,
    ).toBe(second.matchId);
    await capture('03-website-browse');
    await detail.getByRole('button', { name: '核对并载入本场', exact: true }).click();
    await expect.poll(() => selections).toEqual([second.matchId]);
    // A legacy/unconfirmed acknowledgement is not a completed load.
    await expect(detail.getByRole('alert')).toContainText('比赛尚未确认载入');
    const before = refreshes;
    cacheMissing = true;
    await browser.getByRole('button', { name: '刷新比赛', exact: true }).click();
    await expect.poll(() => refreshes).toBeGreaterThan(before);
    await expect(
      page.getByText('网站暂时无法连接，显示上次浏览的资料；载入前会重新核对。', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => detailReads).toEqual([first.matchId, second.matchId, second.matchId]);
    await expect(detail.getByRole('heading', { name: '丙队 vs 丁队', exact: true })).toBeVisible();
    await expect(browser.getByRole('button', { name: /丙队 vs 丁队/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await capture('04-website-cache-missing');
    await page.getByRole('button', { name: '本地赛事', exact: true }).click();
    await detail.getByRole('button', { name: '编辑比赛', exact: true }).click();
    await page.locator('.match-meta-edit > summary').click();
    await page.getByLabel('阶段名称').fill('保留的候选草稿');
    await page.getByRole('button', { name: 'RivalHub 赛事', exact: true }).click();
    await page.getByRole('button', { name: '本地赛事', exact: true }).click();
    await expect(page.getByLabel('阶段名称')).toHaveValue('保留的候选草稿');
    await capture('05-local-edit');
    await detail.getByRole('button', { name: '取消编辑', exact: true }).click();
    await browser.getByRole('button', { name: '在此赛事追加下一场', exact: true }).click();
    await expect(detail.getByRole('heading', { name: '创建本地比赛', exact: true })).toBeVisible();
    await capture('06-local-create');
  } finally {
    await page.close();
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('website schedule keeps all 23 multi-line match choices readable and selectable', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-library-layout-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'tournament.json'),
  });
  try {
    await app.ready();
    const evidenceDirectory = join(process.cwd(), '.agent-tmp/test-evidence/library-layout');
    await mkdir(evidenceDirectory, { recursive: true });
    await context.route(
      (url) => url.pathname.startsWith('/local/v1/') || url.pathname.startsWith('/operator/'),
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/local/v1/rivalhub-connection')
          return route.fulfill({
            json: {
              paired: true,
              displayName: '布局验证',
              activeMatchId: null,
              activeSourceMatchId: null,
            },
          });
        if (path === '/local/v1/rivalhub-schedule')
          return route.fulfill({
            json: {
              competition: { name: '2026 NJU Major 炸鸡杯' },
              matches: websiteSchedule.items.map((item) => ({
                matchId: item.id,
                scheduledAt: item.scheduledAt,
                format: item.format,
                stageLabel: item.stageLabel,
                entrantA: { name: item.title.split(' vs ')[0] },
                entrantB: { name: item.title.split(' vs ')[1] },
              })),
              library: { entries: {}, syncedAt: null, refreshing: true, error: null },
            },
          });
        const response = await app.inject({
          method: request.method() as 'GET' | 'POST',
          url: path,
          headers: request.headers(),
          ...(request.postData() ? { payload: request.postData()! } : {}),
        });
        return route.fulfill({
          status: response.statusCode,
          body: response.body,
          contentType: String(response.headers['content-type'] ?? 'application/json'),
        });
      },
    );
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/resources');
      await page.getByRole('button', { name: 'RivalHub 赛事', exact: true }).click();
      const list = page.getByLabel('赛事赛程');
      const buttons = list.getByRole('button');
      await expect(buttons).toHaveCount(23);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await buttons.evaluateAll((rows) =>
        rows.flatMap((row) => {
          const box = row.getBoundingClientRect();
          return Array.from(row.children)
            .filter((line) => {
              const text = line.getBoundingClientRect();
              return text.top < box.top - 1 || text.bottom > box.bottom + 1;
            })
            .map((line) => line.textContent);
        }),
      );
      expect(overflow).toEqual([]);
      await page.screenshot({
        path: join(evidenceDirectory, `website-schedule-${viewport.width}.png`),
        fullPage: false,
      });
      const last = buttons.last();
      await last.focus();
      await page.keyboard.press('Enter');
      await expect(last).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page
          .getByRole('region', { name: '比赛详情', exact: true })
          .getByRole('heading', { name: websiteSchedule.items.at(-1)!.title, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '刷新比赛', exact: true })).toBeVisible();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
