import type { BrowserContext } from '@playwright/test';
import { expect, test } from './companion-isolation.js';
import { mkdtemp, rm } from 'node:fs/promises';
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
    /\/(?:local\/v1\/bp(?:-workspace)?|operator\/bp-command|operator\/bp-demo|operator\/bp-local-save|operator\/bp-rivalhub)$/,
    async (route) => {
      const request = route.request();
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

test('local BP authoring compiles to MatchContext and survives restart', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'bp-local-acceptance-'));
  const manifestPath = join(directory, 'match.json');
  const bpClock = createManualBpClock();
  let app = buildAppWithManualBpClock(bpClock, { matchManifestPath: manifestPath });
  await routeCompanionApi(context, () => app);
  try {
    await page.goto('/preview?scene=bp');
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'none');
    expect(JSON.parse((await app.inject({ url: '/local/v1/bp-workspace' })).body)).toMatchObject({
      schemaVersion: 'mizar.bp-workspace.v5',
      authoringMode: 'standalone',
    });
    await page.getByRole('button', { name: '本地填写 BP', exact: true }).click();
    const editor = page.locator('.bp-local-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.bp-map-pool input[type="checkbox"]:checked')).toHaveCount(7);

    const format = editor.getByRole('combobox', { name: '比赛赛制' });
    await format.selectOption('bo5');
    const bo5Steps = editor.locator('.bp-sequence-step');
    await expect(bo5Steps).toHaveCount(11);
    await expect(bo5Steps.last()).toContainText('DECIDER');
    await expect(bo5Steps.last().locator('select')).toHaveCount(0);
    await format.selectOption('bo3');

    await editor.locator('.bp-editor-match-fields input').nth(0).fill('本地赛事');
    await editor.locator('.bp-editor-match-fields input').nth(1).fill('决赛');
    await expect(page.getByRole('dialog', { name: '编辑比赛 BP' })).toBeVisible();
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.bp-editor-match-fields input').nth(0)).toHaveValue('本地赛事');
    await editor
      .locator('.bp-editor-team[data-entrant="a"] input')
      .first()
      .fill('本地赛超级无敌大猛男队');
    await editor
      .locator('.bp-editor-team[data-entrant="b"] input')
      .first()
      .fill("Team D'avenir 本地长队");

    const steps = editor.locator('.bp-sequence-step');
    await steps.nth(0).locator('select').selectOption('de_ancient');
    await steps.nth(1).locator('select').selectOption('de_dust2');
    await steps.nth(2).locator('select').selectOption('de_mirage');
    await steps.nth(3).locator('select').selectOption('CT');
    await steps.nth(4).locator('select').selectOption('de_inferno');
    await steps.nth(5).locator('select').selectOption('T');
    await steps.nth(6).locator('select').selectOption('de_anubis');
    await steps.nth(7).locator('select').selectOption('de_cache');
    await steps.nth(9).locator('select').selectOption('T');
    await expect(editor.getByRole('button', { name: '保存本地 BP' })).toBeEnabled();

    await page.getByRole('button', { name: '保存本地 BP', exact: true }).click();
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'local');
    await expect(page.getByRole('heading', { name: '本地 BP 已保存' })).toBeVisible();
    const localWorkspace = await app.inject({ url: '/local/v1/bp-workspace' });
    expect(JSON.parse(localWorkspace.body)).toMatchObject({ source: 'local', readiness: 'ready' });

    await app.close();
    app = buildAppWithManualBpClock(bpClock, { matchManifestPath: manifestPath });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'cache');
    await expect(page.getByRole('heading', { name: '本地 BP 已保存' })).toBeVisible();
    await expect(page.locator('.bp-local-summary')).toContainText("Team D'avenir 本地长队");
    await expect(
      page.getByRole('complementary', { name: '播出控制' }).getByRole('button', {
        name: '编辑本地 BP',
      }),
    ).toBeVisible();
    expect(JSON.parse((await app.inject({ url: '/local/v1/bp-workspace' })).body)).toMatchObject({
      authoringMode: 'standalone',
    });
    await page
      .getByRole('complementary', { name: '播出控制' })
      .getByRole('button', { name: '编辑本地 BP' })
      .click();
    await expect(
      page.locator('.bp-local-editor .bp-editor-match-fields input').first(),
    ).toBeEnabled();
    await expect(page.frameLocator('iframe[title="节目预览"]').locator('.bp-scene')).toHaveCount(0);

    const program = await context.newPage();
    await program.goto('/program/bp');
    await expect(program.locator('.bp-scene')).toHaveCount(0);
    await page
      .getByRole('dialog', { name: '编辑比赛 BP' })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '播放 BP', exact: true }).click();
    await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(1);
    await expect(
      page.frameLocator('iframe[title="节目预览"]').locator('.bp-card[data-visible=true]'),
    ).toHaveCount(1);
    await program.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
