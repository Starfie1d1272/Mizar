import type { BrowserContext } from '@playwright/test';
import { expect, test } from './companion-isolation.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';

async function routeCompanionApi(
  context: BrowserContext,
  getApp: () => ReturnType<typeof buildApp>,
  isOffline: (pathname: string) => boolean = () => false,
  options: {
    readonly transformWorkspace?: (workspace: Record<string, unknown>) => Record<string, unknown>;
    readonly onRequest?: (pathname: string, method: string, body: unknown) => void;
  } = {},
) {
  await context.route(
    (url) => url.pathname.startsWith('/local/v1/') || url.pathname.startsWith('/operator/'),
    async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) return route.fallback();
      const pathname = new URL(request.url()).pathname;
      if (isOffline(pathname)) {
        await route.abort();
        return;
      }
      const payload = request.postData();
      options.onRequest?.(
        pathname,
        request.method(),
        payload === null ? null : JSON.parse(payload),
      );
      let response;
      try {
        response = await getApp().inject({
          method: request.method() as 'GET' | 'POST',
          url: pathname,
          headers: request.headers(),
          ...(payload ? { payload } : {}),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Fastify has already been closed and cannot be reopened'
        ) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'companion_offline' }),
          });
          return;
        }
        throw error;
      }
      const responseBody =
        pathname === '/local/v1/bp-workspace' && options.transformWorkspace
          ? JSON.stringify(
              options.transformWorkspace(JSON.parse(response.body) as Record<string, unknown>),
            )
          : response.body;
      const headers: Record<string, string> = {
        'content-type': String(response.headers['content-type'] ?? 'application/json'),
        'cache-control': String(response.headers['cache-control'] ?? 'no-store'),
      };
      if (response.headers.etag) headers.etag = String(response.headers.etag);
      await route.fulfill({
        status: response.statusCode,
        headers,
        ...(response.statusCode === 304 ? {} : { body: responseBody }),
      });
    },
  );
}

function createManualBpClock() {
  let currentTimeMs = 0;
  return {
    now: () => currentTimeMs,
    advanceBy: (durationMs: number) => {
      currentTimeMs += durationMs;
    },
  };
}

type ManualBpClock = ReturnType<typeof createManualBpClock>;

function buildAppWithManualBpClock(
  clock: ManualBpClock,
  options: Parameters<typeof buildApp>[0] = {},
) {
  return buildApp({ ...options, bpNowMonotonicMs: clock.now });
}

test('local map results and full BP share match details; playback stays outside preparation', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 2560, height: 1440 });
  const capture = async (name: string) => {
    if (!process.env.MIZAR_CAPTURE_BP) return;
    await mkdir('docs/screenshots/bp-workflows', { recursive: true });
    if (name.endsWith('-saved')) await page.locator('#match-bp').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/screenshots/bp-workflows/${name}.png`, fullPage: false });
  };
  const directory = await mkdtemp(join(tmpdir(), 'bp-local-acceptance-'));
  const options = {
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'library.json'),
  };
  const clock = createManualBpClock();
  let app = buildAppWithManualBpClock(clock, options);
  await routeCompanionApi(context, () => app);
  const headers = { origin: 'http://127.0.0.1:3000' };
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers,
          payload: { teamA: 'Alpha', teamB: 'Beta', format: 'bo3' },
        })
      ).statusCode,
    ).toBe(200);
    await page.goto('/operator/bp');
    await expect(page).toHaveURL(/\/matches#match-bp$/);
    await expect(page.getByRole('button', { name: '播放 BP', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '只记录地图结果', exact: true })).toBeEnabled();
    await capture('03-local-details');
    await page.getByRole('button', { name: '只记录地图结果', exact: true }).click();
    await page.getByRole('combobox', { name: '图 1', exact: true }).selectOption('de_mirage');
    await page.getByRole('combobox', { name: '图 2', exact: true }).selectOption('de_inferno');
    await page.getByRole('combobox', { name: '图 3', exact: true }).selectOption('de_nuke');
    await capture('04-map-results-editor');
    await page.getByRole('button', { name: '保存地图结果', exact: true }).click();
    await expect(page.getByText('地图结果已保存；未生成禁选记录。', { exact: true })).toBeVisible();
    const result = (await app.inject({ url: '/local/v1/match-document' })).json<{
      document: { veto: unknown[]; maps: { teamAStartSide: unknown }[] };
    }>();
    expect(result.document.veto).toEqual([]);
    expect(result.document.maps.map((m) => m.teamAStartSide)).toEqual([null, null, null]);
    expect(
      (await app.inject({ url: '/local/v1/bp' })).json<{ projection: unknown }>().projection,
    ).toBeNull();
    await expect(page.getByRole('button', { name: '填写完整 BP', exact: true })).toBeEnabled();
    await capture('05-map-results-saved');
    await page.getByRole('button', { name: '填写完整 BP', exact: true }).click();
    const editor = page.locator('.bp-local-editor');
    const format = editor.getByRole('combobox', { name: '比赛赛制' });
    await format.selectOption('bo5');
    await expect(editor.locator('.bp-sequence-step')).toHaveCount(11);
    await format.selectOption('bo3');
    const steps = editor.locator('.bp-sequence-step');
    for (const [index, value] of [
      [0, 'de_ancient'],
      [1, 'de_dust2'],
      [2, 'de_mirage'],
      [3, 'CT'],
      [4, 'de_inferno'],
      [5, 'T'],
      [6, 'de_anubis'],
      [7, 'de_cache'],
      [9, 'T'],
    ] as const)
      await steps.nth(index).locator('select').selectOption(value);
    await capture('06-full-bp-editor');
    page.once('dialog', (d) => d.dismiss());
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: '保存本地 BP', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('button', { name: '修改完整 BP', exact: true })).toBeVisible();
    expect(
      (await app.inject({ url: '/local/v1/bp-workspace' })).json<{ readiness: string }>().readiness,
    ).toBe('ready');
    await capture('07-full-bp-saved');
    await app.close();
    app = buildAppWithManualBpClock(clock, options);
    await app.ready();
    await page.reload();
    await expect(page.getByRole('button', { name: '修改完整 BP', exact: true })).toBeEnabled();
    const program = await context.newPage();
    await program.goto('/program/bp');
    await expect(program.locator('.bp-scene')).toHaveCount(0);
    const snapshot = (await app.inject({ url: '/local/v1/bp' })).json<{ revision: string }>();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/bp-command',
          headers,
          payload: { kind: 'play', expectedRevision: snapshot.revision },
        })
      ).statusCode,
    ).toBe(200);
    await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(1);
    await program.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
