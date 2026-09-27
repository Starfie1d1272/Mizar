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
    localAuthoringMode: 'bound-overlay',
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
    localAuthoringMode: 'bound-overlay',
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

for (const format of ['bo1', 'bo3', 'bo5'] as const) {
  test(`BP ${format} built-in scene demo drives Preview and Program without a match`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    const app = buildApp();
    await routeCompanionApi(context, () => app);
    await context.route('https://sucokfotkypwqkckfynp.supabase.co/**', (route) => route.abort());
    try {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.goto('/operator/bp');
      await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'none');
      await expect(page.getByRole('button', { name: '本地填写 BP' })).toBeVisible();
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
      }

      const program = await context.newPage();
      await program.goto('/program/bp');
      await expect(program.locator('.bp-scene')).toHaveCount(0);
      const option = page.locator('.bp-demo-option').filter({ hasText: format.toUpperCase() });
      await option.getByRole('button', { name: '开始演示' }).click();
      await expect(page.locator('.bp-source-badge')).toContainText(
        `演示 · ${format.toUpperCase()}`,
      );
      await expect(page.getByRole('region', { name: '当前 BP 演示' })).toContainText(
        format === 'bo1'
          ? 'Team Clarys vs Team Plasma · BO1'
          : format === 'bo3'
            ? "超级无敌大猛男队 vs Team D'avenir · BO3"
            : 'Team Plasma vs 車一进一宝贝队 · BO5',
      );
      await expect(page.getByRole('button', { name: '退出演示' })).toBeVisible();
      await expect(page.getByText('退出演示后可修改真实比赛数据。')).toBeVisible();
      await expect(page.getByRole('button', { name: '本地填写 BP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '补录当前比赛 BP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '切回 RivalHub BP' })).toHaveCount(0);

      await page.getByRole('button', { name: '播放 BP', exact: true }).click();
      await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(1);
      await expect(page.locator('.bp-preview-frame .bp-card[data-visible=true]')).toHaveCount(1);
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown', {
        timeout: 30000,
      });
      await expect(page.locator('.bp-preview-frame .bp-scene')).toHaveAttribute(
        'data-state',
        'shown',
      );
      await expect(program.locator('.bp-card')).toHaveCount(7);
      await expect(program.locator('.bp-card[data-kind="ban"]')).toHaveCount(
        format === 'bo1' ? 6 : format === 'bo3' ? 4 : 2,
      );
      await expect(program.locator('.bp-card[data-kind="pick"]')).toHaveCount(
        format === 'bo1' ? 0 : format === 'bo3' ? 2 : 4,
      );
      await expect(program.locator('.bp-card .bp-side-choice')).toHaveCount(
        format === 'bo1' ? 1 : format === 'bo3' ? 3 : 4,
      );
      await expect(program.locator('.bp-scene')).not.toContainText(/DEMO|TEST|fixture/i);
      await expect(page.locator('.bp-preview-frame .bp-card')).toHaveCount(7);

      const decider = program.locator('.bp-card[data-kind="decider"]');
      if (format === 'bo1') {
        await expect(decider).toContainText('ANCIENT');
        await expect(decider).toContainText('决胜地图');
        await expect(decider.locator('.bp-side-choice')).toContainText('Team Plasma');
        await expect(decider.locator('.bp-side-choice')).toContainText('T 开');
      } else if (format === 'bo3') {
        await expect(decider.locator('.bp-side-choice')).toHaveCount(1);
        await expect(decider.locator('.bp-side-choice')).toContainText("Team D'avenir");
        await expect(decider.locator('.bp-side-choice')).toContainText('T 开');
        await expect(decider.locator('.bp-side-choice[data-entrant="a"]')).toHaveCount(0);
      } else {
        await expect(decider).toContainText('ANUBIS');
        await expect(decider).toContainText('决胜地图');
        await expect(decider.locator('.bp-side-choice')).toHaveCount(0);
        await expect(decider).not.toContainText(/SIDE TBD/i);
      }

      await page.getByRole('button', { name: '收起 BP', exact: true }).click();
      await expect(program.locator('.bp-scene')).toHaveCount(0, { timeout: 5000 });
      await expect(page.locator('.bp-preview-frame .bp-scene')).toHaveCount(0);
      await page.getByRole('button', { name: '退出演示' }).click();
      await expect(page.locator('.bp-source-badge')).toContainText('未连接');
      await expect(page.locator('.bp-scene-testing')).toBeVisible();
      await program.close();
    } finally {
      await app.close();
    }
  });
}

test('BP demo remains stable while the real MatchContext updates and restores its latest projection on exit', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), 'bp-demo-context-switch-'));
  const manifestPath = join(directory, 'match.json');
  const initial = bindingFor('semifinalA');
  const app = buildApp({
    matchContextBinding: {
      ...initial,
      origin: 'local',
      localAuthoringMode: 'standalone',
    },
    matchManifestPath: manifestPath,
  });
  await routeCompanionApi(context, () => app);
  await context.route('https://sucokfotkypwqkckfynp.supabase.co/**', (route) => route.abort());
  try {
    await page.goto('/operator/bp');
    const program = await context.newPage();
    await program.goto('/program/bp');
    await page
      .locator('.bp-demo-option')
      .filter({ hasText: 'BO3' })
      .getByRole('button', { name: '开始演示' })
      .click();
    await page.getByRole('button', { name: '播放 BP', exact: true }).click();
    await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown', {
      timeout: 30000,
    });
    await expect(program.locator('.bp-teams')).toContainText("Team D'avenir");

    const before = JSON.parse((await app.inject('/local/v1/bp-workspace')).body) as {
      contextRevision: string;
      localDraft: Record<string, unknown> & {
        entrants: {
          a: { name: string; logoUrl: string | null };
          b: { name: string; logoUrl: string | null };
        };
      };
    };
    const updatedDraft = {
      ...before.localDraft,
      competitionName: '后台更新后的真实赛事',
      stage: '后台更新后的阶段',
      entrants: {
        a: { ...before.localDraft.entrants.a, name: '真实比赛 B 左队' },
        b: { ...before.localDraft.entrants.b, name: '真实比赛 B 右队' },
      },
    };
    const updated = await app.inject({
      method: 'POST',
      url: '/operator/bp-local-save',
      headers: { origin: 'http://127.0.0.1' },
      payload: { draft: updatedDraft, expectedContextRevision: before.contextRevision },
    });
    expect(updated.statusCode).toBe(200);
    await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown');
    await expect(program.locator('.bp-teams')).toContainText("Team D'avenir");
    await expect(program.locator('.bp-teams')).not.toContainText('真实比赛 B');

    await page.getByRole('button', { name: '收起 BP', exact: true }).click();
    await expect(program.locator('.bp-scene')).toHaveCount(0, { timeout: 5000 });
    await page.getByRole('button', { name: '退出演示' }).click();
    const restored = JSON.parse((await app.inject('/local/v1/bp')).body) as {
      projection: { entrants: { a: { name: string }; b: { name: string } } };
      state: string;
    };
    expect(restored.state).toBe('hidden');
    expect(restored.projection.entrants).toEqual({
      a: expect.objectContaining({ name: '真实比赛 B 左队' }),
      b: expect.objectContaining({ name: '真实比赛 B 右队' }),
    });

    await page.getByRole('button', { name: '播放 BP', exact: true }).click();
    await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'revealing');
    await expect(program.locator('.bp-teams')).toContainText('真实比赛 B 左队');
    await expect(program.locator('.bp-teams')).toContainText('真实比赛 B 右队');
    await program.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    matchContextBinding: {
      ...bindingFor('semifinalA'),
      origin: 'local',
      localAuthoringMode: 'standalone',
    },
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
    expect(JSON.parse((await app.inject({ url: '/local/v1/bp-workspace' })).body)).toMatchObject({
      schemaVersion: 'rivalhub.bp-workspace.v4',
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
  let app = buildApp({
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
      metadata: { localAuthoringMode: string };
      payload: typeof original.manifest;
    };
    const saved = envelope.payload;
    expect(envelope.metadata.localAuthoringMode).toBe('bound-overlay');
    expect(saved.match).toEqual(original.manifest.match);
    expect(saved.entrants).toEqual(original.manifest.entrants);
    expect(saved.commentators).toEqual(original.manifest.commentators);
    expect(saved.maps[0]).toEqual(original.manifest.maps[0]);
    expect(saved.veto).toHaveLength(10);
    expect(saved.maps).toHaveLength(3);

    await app.close();
    app = buildApp({ matchManifestPath: manifestPath });
    await page.reload();
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'cache');
    await page
      .getByRole('complementary', { name: '播出控制' })
      .getByRole('button', { name: '编辑本地 BP', exact: true })
      .click();
    const restoredEditor = page.locator('.bp-local-editor');
    await expect(restoredEditor.locator('.bp-editor-match-fields input').nth(0)).toBeDisabled();
    await expect(restoredEditor.getByRole('combobox', { name: '比赛赛制' })).toBeDisabled();
    await expect(
      restoredEditor.locator('.bp-editor-team[data-entrant="a"] input').first(),
    ).toBeDisabled();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
