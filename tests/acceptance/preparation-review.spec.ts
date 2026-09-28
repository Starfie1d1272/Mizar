import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBroadcastManifest, toMatchContext } from '../../packages/rivalhub/src/index.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

for (const source of ['online', 'cache'] as const) {
  test(`Preparation displays the complete ${source} MatchDocument read-only`, async ({
    page,
    context,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-readonly-ui-'));
    // Contract fixture exercises provider ownership; the logo is an explicit presentation test asset.
    const fixture = JSON.parse(
      await readFile('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json', 'utf8'),
    ) as { entrants: { a: { logoUrl: string } } };
    fixture.entrants.a.logoUrl = 'https://assets.example.test/team-logo.svg';
    const validated = validateBroadcastManifest(fixture);
    if (!validated.ok) throw new Error('invalid fixture');
    const match = toMatchContext(validated.value);
    const app = buildApp({
      matchManifestPath: join(directory, 'match.json'),
      localTournamentPath: join(directory, 'tournament.json'),
      matchContextBinding: {
        manifest: validated.value,
        context: match,
        origin: source,
        freshness: source === 'cache' ? 'stale' : 'fresh',
        diagnostics: [],
      },
    });
    try {
      await app.ready();
      await context.route('https://assets.example.test/team-logo.svg', (route) =>
        route.fulfill({
          path: 'apps/web/public/brand/mizar-mark.svg',
          contentType: 'image/svg+xml',
        }),
      );
      const initial = await app.inject('/local/v1/match-document');
      expect(initial.statusCode, initial.body).toBe(200);
      await context.route(/\/local\/v1\/(?:match-document|tournament)$/, async (route) => {
        const response = await app.inject(new URL(route.request().url()).pathname);
        expect(response.statusCode, response.body).toBe(200);
        await route.fulfill({
          status: response.statusCode,
          body: response.body,
          contentType: 'application/json',
        });
      });
      await page.goto('/matches');
      await expect(page.getByText(match.competition.name, { exact: true })).toBeVisible();
      await expect(page.getByText('计划开始', { exact: true })).toBeVisible();
      await expect(page.getByText('赛事资料由 RivalHub 管理，请通过赛务流程更新。')).toBeVisible();
      await expect(page.getByRole('button', { name: '保存比赛资料' })).toHaveCount(0);
      await page.getByRole('link', { name: '队伍与名单', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: match.entrants.a.name, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('img', { name: `${match.entrants.a.name} 队标` })).toBeVisible();
      await expect(
        page.locator('.preparation-roster').getByText('星火一号', { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.preparation-roster').getByText('星火替补', { exact: true }),
      ).toBeVisible();
      if (process.env.MIZAR_REVIEW_SCREENSHOTS === '1')
        await page.screenshot({ path: `.agent-tmp/review-${source}-roster.png`, fullPage: true });
      await page.getByText('Steam 身份', { exact: true }).first().click();
      await expect(page.getByText('76561198000000001', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '从当前服务器识别首发' })).toHaveCount(0);
      await page.getByRole('link', { name: '地图与 BP', exact: true }).click();
      await expect(page.getByRole('list', { name: 'BP 步骤' })).toContainText('禁用 · de_dust2');
      await expect(page.getByText('de_ancient · 16 : 12', { exact: false })).toBeVisible();
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('Tool surfaces retain their role and Preview changes never TAKE a scene', async ({
  page,
  context,
}) => {
  const commands: string[] = [];
  await context.route('**/operator/program-scene', (route) => {
    commands.push(route.request().url());
    return route.fulfill({ json: {} });
  });
  for (const path of ['/operator/hud', '/operator/bp', '/debug', '/preview']) {
    await page.goto(path);
    await expect(page.locator('.mizar-tool-heading')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '制作导航' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '总览', exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: '对阵 · 不可用', exact: true }).click();
  await expect(page.getByTitle('节目预览', { exact: true })).toHaveAttribute(
    'src',
    '/program/matchup?preview=1',
  );
  expect(commands).toEqual([]);
  await page.goto('/picture');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开独立节目预览' }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/preview$/);
  await expect(popup.getByRole('navigation', { name: '制作导航' })).toHaveCount(0);
  // Named window recovery: even a previously drifted browser tool is restored when reopened.
  await popup.goto('/');
  await page.getByRole('button', { name: '打开独立节目预览' }).click();
  await expect(popup).toHaveURL(/\/preview$/);
  await expect(popup.locator('.mizar-tool-heading')).toBeVisible();
  await expect(popup.frameLocator('iframe').locator('.program-scene--waiting')).toBeVisible();
  if (process.env.MIZAR_REVIEW_SCREENSHOTS === '1')
    await popup.screenshot({ path: '.agent-tmp/review-preview.png' });
  await popup.close();
});

test('server quick create requires an explicit saved Team decision and sends only candidate proof plus choices', async ({
  page,
}) => {
  // Synthetic candidate exercises confirmation UI; production evidence validation is covered by Companion tests.
  const players = (offset: number) =>
    Array.from({ length: 5 }, (_, i) => ({
      steam64: `765611980000000${offset + i}`,
      displayName: `Observed ${offset + i}`,
    }));
  let generation = 1;
  await page.route('**/local/v1/roster-candidate', (route) =>
    route.fulfill({
      json: {
        local: false,
        candidate: {
          revision: `candidate-${generation}`,
          contextRevision: 'context-1',
          sourceGeneration: generation,
          mapEpoch: 2,
          ctName: 'Alpha',
          tName: 'Beta',
          ctEntrant: null,
          ct: players(10),
          t: players(20),
          teamOptions: {
            ct: [{ teamId: 'saved-alpha', name: 'Alpha' }],
            t: [{ teamId: 'saved-beta', name: 'Beta' }],
          },
        },
      },
    }),
  );
  let submitted: unknown;
  await page.route('**/operator/local-match/create-from-server', (route) => {
    submitted = route.request().postDataJSON() as unknown;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/matches?tab=roster&createFromServer=1');
  const capture = page.locator('.preparation-capture');
  const create = capture.getByRole('button', { name: '创建本地比赛', exact: true });
  await expect(create).toBeDisabled();
  await capture.getByLabel('CT 队伍资料', { exact: true }).selectOption('saved-alpha');
  await expect(create).toBeDisabled();
  await capture.getByLabel('T 队伍资料', { exact: true }).selectOption('new');
  await expect(create).toBeEnabled();
  generation = 2;
  await expect(capture.getByText('服务器名单已变化，请重新识别。', { exact: true })).toBeVisible();
  await expect(create).toBeDisabled();
  await capture.getByRole('button', { name: '从当前服务器创建比赛', exact: true }).click();
  await capture.getByLabel('CT 队伍资料', { exact: true }).selectOption('saved-alpha');
  await capture.getByLabel('T 队伍资料', { exact: true }).selectOption('new');
  await expect(create).toBeEnabled();
  await create.click();
  await expect
    .poll(() => submitted)
    .toEqual({
      candidateRevision: 'candidate-2',
      expectedContextRevision: 'context-1',
      expectedSourceGeneration: 2,
      expectedMapEpoch: 2,
      ctEntrant: '',
      teamA: '',
      teamB: '',
      format: 'bo3',
      teamAId: 'saved-alpha',
    });
});

test('Overview attention contains recovery actions rather than duplicating optional capability failures', async ({
  page,
}) => {
  await page.route('**/local/v1/readiness', (route) =>
    route.fulfill({
      json: [
        {
          label: 'BP 画面',
          ready: false,
          reason: '等待 BP',
          href: '/matches?tab=maps',
          action: null,
        },
        {
          label: '比赛画面',
          ready: false,
          reason: '等待比赛数据',
          href: '/settings?tab=gsi',
          action: null,
        },
        {
          label: '对阵画面',
          ready: false,
          reason: '等待比赛资料',
          href: '/matches?tab=roster',
          action: null,
        },
        {
          label: 'OBS',
          ready: false,
          reason: '浏览器源地址需要修复',
          href: '/settings?tab=obs',
          action: '检查 OBS 连接与配置',
        },
      ],
    }),
  );
  await page.goto('/');
  const attention = page
    .locator('.mizar-panel')
    .filter({ has: page.getByRole('heading', { name: '需要关注', exact: true }) });
  await expect(attention.getByRole('link')).toHaveCount(1);
  await expect(attention.getByRole('link')).toHaveText('检查 OBS 连接与配置 →');
  await expect(attention.getByRole('link')).toHaveAttribute('href', '/settings?tab=obs');
  await expect(page.locator('.preparation-readiness').filter({ hasText: 'OBS' })).toContainText(
    '浏览器源地址需要修复',
  );
});
