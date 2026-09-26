import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toMatchContext, validateBroadcastManifest } from '../../packages/rivalhub/src/index.js';
import { buildApp } from '../../apps/companion/src/app.js';
import type { MatchContextBinding } from '../../apps/companion/src/match-context/index.js';
import { bpManifestFixture } from './bp-manifest-fixture.js';

function bindingFor(key: 'semifinalA' | 'final'): MatchContextBinding {
  const candidate = bpManifestFixture(key);
  const validated = validateBroadcastManifest(candidate);
  if (!validated.ok) throw new Error(`BP acceptance Manifest invalid: ${key}`);
  return {
    manifest: validated.value,
    context: toMatchContext(validated.value),
    origin: 'online',
    freshness: 'fresh',
    diagnostics: validated.diagnostics,
  };
}

async function partiallyRecordedBinding(): Promise<MatchContextBinding> {
  const candidate: unknown = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  );
  const validated = validateBroadcastManifest(candidate);
  if (!validated.ok) throw new Error('Partial BP acceptance Manifest invalid');
  return {
    manifest: validated.value,
    context: toMatchContext(validated.value),
    origin: 'online',
    freshness: 'fresh',
    diagnostics: validated.diagnostics,
  };
}

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
    /\/(?:local\/v1\/bp(?:-workspace)?|operator\/bp-command|operator\/bp-local-save|operator\/bp-rivalhub)$/,
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
      const response = await getApp().inject({
        method: request.method() as 'GET' | 'POST',
        url: pathname,
        headers: request.headers(),
        ...(payload ? { payload } : {}),
      });
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

for (const key of ['semifinalA', 'final'] as const) {
  test(`BP ${key}: RivalHub context, shared reveal, reload and recovery`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    const directory = await mkdtemp(join(tmpdir(), 'bp-acceptance-'));
    const app = buildApp({
      matchContextBinding: bindingFor(key),
      matchManifestPath: join(directory, 'match.json'),
    });
    let offline = false;
    await routeCompanionApi(
      context,
      () => app,
      (pathname) => offline && pathname === '/local/v1/bp',
    );
    await context.route('https://sucokfotkypwqkckfynp.supabase.co/**', (route) => route.abort());
    try {
      await page.goto('/operator/bp');
      await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'online');
      await expect(page.getByRole('status').filter({ hasText: 'BP 已就绪' })).toBeVisible();
      await expect(page.getByRole('button', { name: '补录当前比赛 BP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '本地填写 BP' })).toHaveCount(0);
      await expect(page.locator('.bp-preview-frame .bp-scene')).toHaveCount(0);

      const program = await context.newPage();
      await program.goto('/program/bp');
      await expect(program.locator('.bp-scene')).toHaveCount(0);
      await page.getByRole('button', { name: '播放 BP', exact: true }).click();
      await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(1);
      await expect(page.locator('.bp-preview-frame .bp-card[data-visible=true]')).toHaveCount(1);
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown', {
        timeout: 30000,
      });
      await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(7);
      await expect(page.locator('.bp-preview-frame .bp-scene')).toHaveAttribute(
        'data-state',
        'shown',
      );
      await expect(page.locator('.bp-preview-frame .bp-card[data-visible=true]')).toHaveCount(7);

      const decider = program.locator('.bp-card[data-kind="decider"]');
      await expect(decider).toHaveAttribute('data-entrant', 'none');
      if (key === 'semifinalA') {
        const sideChoice = decider.locator('.bp-side-choice');
        await expect(sideChoice).toHaveCount(1);
        await expect(sideChoice).toContainText("Team D'avenir");
        await expect(sideChoice).toContainText('T 开');
        await expect(sideChoice).toBeVisible();
        await expect(decider.locator('.bp-side-choice[data-entrant="a"]')).toHaveCount(0);
      } else {
        await expect(decider.locator('.bp-side-choice')).toHaveCount(0);
      }
      await expect(program.locator('.bp-card .bp-side-choice')).toHaveCount(
        key === 'semifinalA' ? 3 : 4,
      );
      const sceneBounds = await program.locator('.bp-scene').boundingBox();
      expect(sceneBounds?.width).toBe(1920);
      expect(sceneBounds?.height).toBe(1080);
      await expect(program.locator('.bp-scene')).toHaveCSS('background-color', 'rgb(8, 13, 22)');

      await program.reload();
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown');
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-animate', 'false');
      offline = true;
      await expect(program.locator('.bp-scene')).toHaveCount(0, { timeout: 5000 });
      offline = false;
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown');
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-animate', 'false');

      await page.getByRole('button', { name: '收起 BP', exact: true }).click();
      await expect(program.locator('.bp-scene')).toHaveCount(0, { timeout: 5000 });
      await expect(page.locator('.bp-preview-frame .bp-scene')).toHaveCount(0);
      await page.getByRole('button', { name: '播放 BP', exact: true }).click();
      await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(1);
      await expect(page.locator('.bp-preview-frame .bp-card[data-visible=true]')).toHaveCount(1);
      await program.close();
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('cache from RivalHub does not offer local override or a redundant source switch', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'bp-online-cache-'));
  const onlineBinding = bindingFor('semifinalA');
  const app = buildApp({
    matchContextBinding: {
      ...onlineBinding,
      origin: 'cache',
      cachedFrom: 'online',
      storedAt: '2026-09-27T00:00:00.000Z',
    },
    matchManifestPath: join(directory, 'match.json'),
  });
  await routeCompanionApi(context, () => app);
  try {
    await page.goto('/operator/bp');
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'cache');
    await expect(page.getByRole('button', { name: '本地填写 BP' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '补录当前比赛 BP' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '切回 RivalHub BP' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local BP shows a bounded RivalHub candidate summary and sends both revisions on confirmation', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'bp-pending-online-'));
  const app = buildApp({
    matchContextBinding: { ...bindingFor('semifinalA'), origin: 'local' },
    matchManifestPath: join(directory, 'match.json'),
  });
  let switchCommand: unknown;
  await routeCompanionApi(
    context,
    () => app,
    () => false,
    {
      transformWorkspace: (workspace) => ({
        ...workspace,
        pendingRivalhub: {
          revision: 'candidate-revision-17',
          competition: '哥本哈根 Major',
          stage: '四分之一决赛',
          format: 'bo3',
          entrants: {
            a: { name: 'NAVI' },
            b: { name: 'Vitality' },
          },
        },
      }),
      onRequest: (pathname, method, body) => {
        if (pathname === '/operator/bp-rivalhub' && method === 'POST') switchCommand = body;
      },
    },
  );
  try {
    await page.goto('/operator/bp');
    const candidate = page.getByRole('region', { name: '待确认的 RivalHub 比赛' });
    await expect(candidate).toContainText('NAVI vs Vitality · BO3');
    await expect(candidate).toContainText('哥本哈根 Major · 四分之一决赛');
    await candidate.getByRole('button', { name: '切回 RivalHub BP' }).click();
    await expect
      .poll(() => switchCommand)
      .toEqual({
        expectedContextRevision: expect.any(String),
        expectedPendingRevision: 'candidate-revision-17',
      });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local BP authoring compiles to MatchContext, survives restart, and stays responsive', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'bp-local-acceptance-'));
  const manifestPath = join(directory, 'match.json');
  let app = buildApp({ matchManifestPath: manifestPath });
  await routeCompanionApi(context, () => app);
  try {
    await page.goto('/operator/bp');
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'none');
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

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(width);
    }
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);

    await page.getByRole('button', { name: '保存本地 BP', exact: true }).click();
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'local');
    await expect(page.getByRole('heading', { name: '本地 BP 已保存' })).toBeVisible();
    const localWorkspace = await app.inject({ url: '/local/v1/bp-workspace' });
    expect(JSON.parse(localWorkspace.body)).toMatchObject({ source: 'local', readiness: 'ready' });

    await app.close();
    app = buildApp({ matchManifestPath: manifestPath });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'cache');
    await expect(page.getByRole('heading', { name: '本地 BP 已保存' })).toBeVisible();
    await expect(page.locator('.bp-local-summary')).toContainText("Team D'avenir 本地长队");
    await expect(
      page.getByRole('complementary', { name: '播出控制' }).getByRole('button', {
        name: '编辑本地 BP',
      }),
    ).toBeVisible();
    await expect(page.locator('.bp-preview-frame .bp-scene')).toHaveCount(0);

    const program = await context.newPage();
    await program.goto('/program/bp');
    await expect(program.locator('.bp-scene')).toHaveCount(0);
    await page.getByRole('button', { name: '播放 BP', exact: true }).click();
    await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(1);
    await expect(page.locator('.bp-preview-frame .bp-card[data-visible=true]')).toHaveCount(1);
    await program.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await program
        .locator('.bp-scene')
        .evaluate((node) => getComputedStyle(node).transitionProperty),
    ).toBe('none');
    await program.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('bound RivalHub BP fallback locks canonical identity and preserves roster and played maps', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'bp-bound-fallback-'));
  const manifestPath = join(directory, 'match.json');
  const original = await partiallyRecordedBinding();
  const app = buildApp({
    matchContextBinding: original,
    matchManifestPath: manifestPath,
  });
  await routeCompanionApi(context, () => app);
  try {
    await page.goto('/operator/bp');
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'online');
    await expect(page.getByRole('button', { name: '补录当前比赛 BP' })).toBeVisible();
    await page.getByRole('button', { name: '补录当前比赛 BP' }).click();
    const editor = page.locator('.bp-local-editor');
    await expect(editor.getByRole('heading', { name: '为当前比赛补录 BP' })).toBeVisible();
    await expect(editor.locator('.bp-editor-match-fields input').nth(0)).toBeDisabled();
    await expect(editor.locator('.bp-editor-match-fields input').nth(1)).toBeDisabled();
    await expect(editor.getByRole('combobox', { name: '比赛赛制' })).toBeDisabled();
    await expect(editor.locator('.bp-editor-team[data-entrant="a"] input').first()).toBeDisabled();
    await expect(editor.locator('.bp-editor-team[data-entrant="b"] input').first()).toBeDisabled();

    const steps = editor.locator('.bp-sequence-step');
    await steps.nth(2).locator('select').selectOption('de_ancient');
    await steps.nth(3).locator('select').selectOption('CT');
    await steps.nth(4).locator('select').selectOption('de_mirage');
    await steps.nth(5).locator('select').selectOption('T');
    await steps.nth(6).locator('select').selectOption('de_anubis');
    await steps.nth(7).locator('select').selectOption('de_cache');
    await steps.nth(9).locator('select').selectOption('CT');
    await expect(editor.getByRole('button', { name: '保存本地 BP' })).toBeEnabled();
    await editor.getByRole('button', { name: '保存本地 BP' }).click();
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'local');

    const envelope = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      payload: typeof original.manifest;
    };
    const saved = envelope.payload;
    expect(saved.match).toEqual(original.manifest.match);
    expect(saved.entrants).toEqual(original.manifest.entrants);
    expect(saved.commentators).toEqual(original.manifest.commentators);
    expect(saved.maps[0]).toEqual(original.manifest.maps[0]);
    expect(saved.veto).toHaveLength(10);
    expect(saved.maps).toHaveLength(3);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
