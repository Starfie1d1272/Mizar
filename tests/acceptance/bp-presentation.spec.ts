import type { BpSnapshot } from '../../packages/protocol/src/bp.js';
import type { BrowserContext, FrameLocator, Page } from '@playwright/test';
import { expect, test } from './companion-isolation.js';
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

async function playAndRevealBp(
  operator: Page,
  app: ReturnType<typeof buildApp>,
  clock: ManualBpClock,
  surfaces: readonly (Page | FrameLocator)[],
) {
  await operator.getByRole('button', { name: '播放 BP', exact: true }).click();
  for (const surface of surfaces) {
    const scene = surface.locator('.bp-scene');
    await expect(scene).toHaveAttribute('data-state', 'revealing');
    await expect(scene.locator('.bp-card[data-visible=true]')).toHaveCount(1);
  }

  const initial = JSON.parse((await app.inject('/local/v1/bp')).body) as {
    projection: { steps: readonly unknown[]; format: string } | null;
    revealedCount: number;
    state: string;
  };
  expect(initial).toMatchObject({ revealedCount: 1, state: 'revealing' });
  if (initial.projection === null) throw new Error('BP reveal lost its presentation projection');
  let revealedSteps = 1;
  if (initial.projection.format !== 'bo1') {
    clock.advanceBy(3200);
    for (const surface of surfaces) {
      const firstPick = surface.locator('.bp-card[data-kind="pick"]').first();
      await expect(firstPick).toHaveAttribute('data-visible', 'true');
      await expect(firstPick.locator('.bp-side-choice')).toHaveCSS('opacity', '0');
      await expect(firstPick.locator('.bp-side-choice')).toHaveAttribute('aria-hidden', 'true');
    }
    clock.advanceBy(1600);
    for (const surface of surfaces) {
      const firstPick = surface.locator('.bp-card[data-kind="pick"]').first();
      await expect(firstPick.locator('.bp-side-choice')).toHaveAttribute('aria-hidden', 'false');
      await expect(firstPick.locator('.bp-side-choice')).toHaveCSS('opacity', '1');
    }
    revealedSteps = 4;
  }
  clock.advanceBy(Math.max(0, initial.projection.steps.length - revealedSteps) * 1600);
  for (const surface of surfaces) {
    await expect(surface.locator('.bp-scene')).toHaveAttribute('data-state', 'shown', {
      timeout: 5000,
    });
  }
}

async function hideBp(
  operator: Page,
  app: ReturnType<typeof buildApp>,
  clock: ManualBpClock,
  surfaces: readonly (Page | FrameLocator)[],
) {
  const [response] = await Promise.all([
    operator.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/operator/bp-command' &&
        response.request().method() === 'POST',
    ),
    operator.getByRole('button', { name: '收起 BP', exact: true }).click(),
  ]);
  expect(response.ok()).toBe(true);
  const hiding = JSON.parse((await app.inject('/local/v1/bp')).body) as { state: string };
  expect(hiding.state).toBe('hiding');
  clock.advanceBy(360);
  const hidden = JSON.parse((await app.inject('/local/v1/bp')).body) as { state: string };
  expect(hidden.state).toBe('hidden');
  for (const surface of surfaces) {
    await expect(surface.locator('.bp-scene')).toHaveCount(0, { timeout: 5000 });
  }
}

for (const format of ['bo1', 'bo3', 'bo5'] as const) {
  test(`BP ${format} built-in scene demo drives Preview and Program without a match`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    const bpClock = createManualBpClock();
    const app = buildAppWithManualBpClock(bpClock);
    await routeCompanionApi(context, () => app);
    await context.route(
      /^https:\/\/(?:sucokfotkypwqkckfynp\.supabase\.co|img-cdn\.hltv\.org)\//,
      (route) => route.abort(),
    );
    try {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.goto('/operator/bp');
      await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'none');
      await expect(page.getByRole('button', { name: '本地填写 BP' })).toBeVisible();

      const program = await context.newPage();
      await program.goto('/program/bp');
      await expect(program.locator('.bp-scene')).toHaveCount(0);
      await page.getByText('场景测试 · 内置演示数据', { exact: true }).click();
      const option = page.locator('.bp-demo-option').filter({ hasText: format.toUpperCase() });
      await option.getByRole('button', { name: '开始演示' }).click();
      await expect(page.locator('.bp-source-badge')).toContainText(
        `演示 · ${format.toUpperCase()}`,
      );
      await expect(page.getByRole('region', { name: '当前 BP 演示' })).toContainText(
        format === 'bo1'
          ? '示例队伍 A vs 示例队伍 B · BO1'
          : format === 'bo3'
            ? 'Falcons vs Natus Vincere · BO3'
            : '示例队伍 A vs 示例队伍 B · BO5',
      );
      await expect(page.getByRole('button', { name: '退出演示' })).toBeVisible();
      await expect(page.getByText('退出演示后可修改真实比赛数据。')).toBeVisible();
      await expect(page.getByRole('button', { name: '本地填写 BP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '补录当前比赛 BP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '切回 RivalHub BP' })).toHaveCount(0);

      await playAndRevealBp(page, app, bpClock, [
        program,
        page.frameLocator('iframe[title="节目预览"]'),
      ]);
      await expect(program.locator('.bp-card')).toHaveCount(7);
      await expect(program.locator('.bp-card[data-kind="ban"]')).toHaveCount(
        format === 'bo1' ? 6 : format === 'bo3' ? 4 : 2,
      );
      await expect(program.locator('.bp-card[data-kind="pick"]')).toHaveCount(
        format === 'bo1' ? 0 : format === 'bo3' ? 2 : 4,
      );
      await expect(program.locator('.bp-card .bp-side-choice')).toHaveCount(
        format === 'bo1' ? 1 : format === 'bo3' ? 2 : 4,
      );
      await expect(program.locator('.bp-scene')).not.toContainText(/DEMO|TEST|fixture/i);
      await expect(page.frameLocator('iframe[title="节目预览"]').locator('.bp-card')).toHaveCount(
        7,
      );

      await page.goto('/preview?scene=bp');
      await page.getByRole('button', { name: '半场', exact: true }).click();
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.summary-players'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'BP', exact: true }).click();
      await expect(page.locator('iframe[title="节目预览"]')).toHaveCount(1);
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.bp-scene'),
      ).toHaveAttribute('data-state', 'shown');
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.bp-card[data-visible=true]'),
      ).toHaveCount(7);

      await test.info().attach(`bp-${format}-full-screen`, {
        body: await program.screenshot(),
        contentType: 'image/png',
      });
      const decider = program.locator('.bp-card[data-kind="decider"]');
      if (format === 'bo1') {
        await expect(decider).toContainText('INFERNO');
        await expect(decider).toContainText('决胜地图');
        await expect(decider.locator('.bp-side-choice')).toContainText('示例队伍 B');
        await expect(decider.locator('.bp-side-choice')).toContainText('T 开');
      } else if (format === 'bo3') {
        await expect(decider.locator('.bp-side-choice')).toHaveCount(0);
        await expect(decider.locator('.bp-side-choice[data-entrant="a"]')).toHaveCount(0);
      } else {
        await expect(decider).toContainText('MIRAGE');
        await expect(decider).toContainText('决胜地图');
        await expect(decider.locator('.bp-side-choice')).toHaveCount(0);
        await expect(decider).not.toContainText(/SIDE TBD/i);
      }

      await page.goto('/operator/bp');
      await hideBp(page, app, bpClock, [program, page.frameLocator('iframe[title="节目预览"]')]);
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
  const bpClock = createManualBpClock();
  const app = buildAppWithManualBpClock(bpClock, {
    matchContextBinding: {
      ...initial,
      origin: 'local',
      localAuthoringMode: 'standalone',
    },
    matchManifestPath: manifestPath,
  });
  await routeCompanionApi(context, () => app);
  await context.route(
    /^https:\/\/(?:sucokfotkypwqkckfynp\.supabase\.co|img-cdn\.hltv\.org)\//,
    (route) => route.abort(),
  );
  try {
    await page.goto('/operator/bp');
    const program = await context.newPage();
    await program.goto('/program/bp');
    await page.getByText('场景测试 · 内置演示数据', { exact: true }).click();
    await page
      .locator('.bp-demo-option')
      .filter({ hasText: 'BO3' })
      .getByRole('button', { name: '开始演示' })
      .click();
    await playAndRevealBp(page, app, bpClock, [program]);
    await expect(program.locator('.bp-teams')).toContainText('Falcons');

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
    await expect(program.locator('.bp-teams')).toContainText('Falcons');
    await expect(program.locator('.bp-teams')).not.toContainText('真实比赛 B');

    await hideBp(page, app, bpClock, [program]);
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
    const bpClock = createManualBpClock();
    const app = buildAppWithManualBpClock(bpClock, {
      matchContextBinding: bindingFor(key),
      matchManifestPath: join(directory, 'match.json'),
    });
    let offline = false;
    await routeCompanionApi(
      context,
      () => app,
      (pathname) => offline && pathname === '/local/v1/bp',
    );
    await context.route(
      /^https:\/\/(?:sucokfotkypwqkckfynp\.supabase\.co|img-cdn\.hltv\.org)\//,
      (route) => route.abort(),
    );
    try {
      await page.goto('/operator/bp');
      await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'online');
      await expect(page.getByRole('status').filter({ hasText: 'BP 已就绪' })).toBeVisible();
      await expect(page.getByRole('button', { name: '补录当前比赛 BP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '本地填写 BP' })).toHaveCount(0);
      await expect(page.frameLocator('iframe[title="节目预览"]').locator('.bp-scene')).toHaveCount(
        0,
      );

      const program = await context.newPage();
      await program.goto('/program/bp');
      await expect(program.locator('.bp-scene')).toHaveCount(0);
      await playAndRevealBp(page, app, bpClock, [
        program,
        page.frameLocator('iframe[title="节目预览"]'),
      ]);
      await expect(program.locator('.bp-card[data-visible=true]')).toHaveCount(7);
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.bp-scene'),
      ).toHaveAttribute('data-state', 'shown');
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.bp-card[data-visible=true]'),
      ).toHaveCount(7);

      await page.goto('/preview?scene=bp');
      await page.getByRole('button', { name: '半场', exact: true }).click();
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.summary-players'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'BP', exact: true }).click();
      await expect(page.locator('iframe[title="节目预览"]')).toHaveCount(1);
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.bp-scene'),
      ).toHaveAttribute('data-state', 'shown');
      await expect(
        page.frameLocator('iframe[title="节目预览"]').locator('.bp-card[data-visible=true]'),
      ).toHaveCount(7);

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

      await program.reload();
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown');
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-animate', 'false');
      offline = true;
      await expect(program.locator('.bp-scene')).toHaveCount(0, { timeout: 5000 });
      offline = false;
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-state', 'shown');
      await expect(program.locator('.bp-scene')).toHaveAttribute('data-animate', 'false');

      await page.goto('/operator/bp');
      await hideBp(page, app, bpClock, [program, page.frameLocator('iframe[title="节目预览"]')]);
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
}

test('cache from RivalHub does not offer local override or a redundant source switch', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'bp-online-cache-'));
  const bpClock = createManualBpClock();
  const onlineBinding = bindingFor('semifinalA');
  const app = buildAppWithManualBpClock(bpClock, {
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
  const bpClock = createManualBpClock();
  const app = buildAppWithManualBpClock(bpClock, {
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
    page.once('dialog', (dialog) => dialog.accept());
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

test('event BO3 controls save EPL opponent side choices without a decider selection', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'bp-epl-controls-'));
  const clock = createManualBpClock();
  const options = {
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'local.json'),
  };
  let app = buildAppWithManualBpClock(clock, options);
  await routeCompanionApi(context, () => app);
  try {
    await page.goto('/operator/bp');
    await page.getByRole('button', { name: '本地填写 BP', exact: true }).click();
    const editor = page.locator('.bp-local-editor');
    await editor.getByRole('textbox', { name: '赛事名称 可选' }).fill('ESL Pro League Season 24');
    await editor.locator('.bp-editor-team[data-entrant="a"] input').first().fill('Falcons');
    await editor.locator('.bp-editor-team[data-entrant="b"] input').first().fill('Natus Vincere');
    await editor.getByRole('combobox', { name: '先禁图方', exact: true }).selectOption('b');
    const order = editor.getByRole('combobox', { name: 'BO3 最后两次禁图', exact: true });
    const decider = editor.getByRole('combobox', { name: 'BO3 决胜图起始阵营', exact: true });
    await order.selectOption('veto_a_first');
    await order.focus();
    await page.keyboard.press('Tab');
    await expect(decider).toBeFocused();
    expect(await decider.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    await decider.selectOption('in_game');
    const steps = editor.locator('.bp-sequence-step');
    await expect(steps).toHaveCount(9);
    const inputs = [
      'de_dust2',
      'de_cache',
      'de_inferno',
      'CT',
      'de_anubis',
      'T',
      'de_ancient',
      'de_nuke',
    ];
    for (const [index, value] of inputs.entries())
      await steps.nth(index).locator('select').selectOption(value);
    await expect(steps.nth(6).locator('.bp-sequence-actor')).toHaveText('Natus Vincere');
    await expect(steps.nth(7).locator('.bp-sequence-actor')).toHaveText('Falcons');
    await expect(steps.nth(8).locator('.bp-sequence-decider')).toHaveText('Mirage');
    const save = editor.getByRole('button', { name: '保存本地 BP', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(editor).not.toBeVisible();
    const before = (await app.inject('/local/v1/bp')).json<{
      projection: { cards: { sideChoice: unknown }[]; steps: unknown[] };
    }>();
    expect(before.projection.steps).toHaveLength(9);
    expect(before.projection.cards[2]!.sideChoice).toEqual({ entrant: 'a', side: 'CT' });
    expect(before.projection.cards[3]!.sideChoice).toEqual({ entrant: 'b', side: 'T' });
    expect(before.projection.cards[6]!.sideChoice).toBeNull();
    await app.close();
    app = buildAppWithManualBpClock(clock, options);
    await app.ready();
    expect((await app.inject('/local/v1/bp')).json()).toMatchObject({
      projection: before.projection,
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    await page.goto('/operator/bp');
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
    await expect(page.getByRole('status').filter({ hasText: 'BP 已就绪' })).toBeVisible();
    const localWorkspace = await app.inject({ url: '/local/v1/bp-workspace' });
    expect(JSON.parse(localWorkspace.body)).toMatchObject({ source: 'local', readiness: 'ready' });

    await app.close();
    app = buildAppWithManualBpClock(bpClock, { matchManifestPath: manifestPath });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.bp-source-badge')).toHaveAttribute('data-source', 'cache');
    await expect(page.getByRole('status').filter({ hasText: 'BP 已就绪' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '播出控制' })).toContainText(
      "Team D'avenir 本地长队",
    );
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

for (const failure of ['network', 'timeout'] as const)
  test(`BP workspace ${failure} preserves unsaved edits and restores saving after reconnection`, async ({
    page,
    context,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-disconnect-'));
    const app = buildAppWithManualBpClock(createManualBpClock(), {
      matchContextBinding: {
        ...bindingFor('semifinalA'),
        origin: 'local',
        localAuthoringMode: 'standalone',
      },
      matchManifestPath: join(directory, 'match.json'),
    });
    let offline = false;
    await routeCompanionApi(
      context,
      () => app,
      (path) => failure === 'network' && offline && path === '/local/v1/bp-workspace',
    );
    if (failure === 'timeout')
      await context.route('**/local/v1/bp-workspace', async (route) => {
        if (!offline) return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await route.abort().catch(() => undefined);
      });
    try {
      await page.goto('/operator/bp');
      await page
        .getByRole('complementary', { name: '播出控制' })
        .getByRole('button', { name: '编辑本地 BP', exact: true })
        .click();
      const editor = page.locator('.bp-local-editor');
      const title = editor.locator('.bp-editor-match-fields input').first();
      await title.fill('保留未保存的测试草稿');
      const save = editor.getByRole('button', { name: '保存本地 BP', exact: true });
      await expect(save).toBeEnabled();
      offline = true;
      await expect(editor.getByRole('alert')).toContainText('制作服务断开');
      await expect(title).toHaveValue('保留未保存的测试草稿');
      await expect(save).toBeDisabled();
      let closeAsked = false;
      page.once('dialog', async (dialog) => {
        closeAsked = true;
        await dialog.dismiss();
      });
      await page
        .getByRole('dialog', { name: '编辑比赛 BP' })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      expect(closeAsked).toBe(true);
      await expect(title).toHaveValue('保留未保存的测试草稿');
      offline = false;
      await expect(save).toBeEnabled();
      await expect(title).toHaveValue('保留未保存的测试草稿');
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
  const bpClock = createManualBpClock();
  const original = await partiallyRecordedBinding();
  let app = buildAppWithManualBpClock(bpClock, {
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
    app = buildAppWithManualBpClock(bpClock, { matchManifestPath: manifestPath });
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

test('formal BP address keeps control separate from read-only preview', async ({ page }) => {
  await page.goto('/operator/bp?qualification=1');
  await expect(page).toHaveURL(/\/operator\/bp\?qualification=1$/);
  await expect(page.getByRole('button', { name: '播放 BP', exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="节目预览"]')).toHaveAttribute(
    'src',
    '/program/bp?preview=1',
  );
  await page.goto('/preview?scene=bp');
  await expect(page.getByRole('button', { name: '播放 BP', exact: true })).toHaveCount(0);
});

test('BP team media falls back and recovers without moving long-name cards', async ({ page }) => {
  const app = buildApp({ matchContextBinding: bindingFor('semifinalA') });
  try {
    const baseline = JSON.parse((await app.inject('/local/v1/bp')).body) as BpSnapshot;
    if (!baseline.projection) throw new Error('Missing BP media test projection');
    const projection = {
      ...baseline.projection,
      entrants: {
        a: { name: '中文长队名用于合成布局边界检查'.repeat(4), logoUrl: '/bp-media/empty.svg' },
        b: {
          name: 'Synthetic Long English Team Name For Broadcast Layout '.repeat(2).slice(0, 80),
          logoUrl: '/bp-media/missing.webp',
        },
      },
    };
    let snapshot: BpSnapshot = {
      ...baseline,
      projection,
      state: 'shown',
      revealedCount: projection.steps.length,
      revision: 'media-1',
    };
    await page.route('**/local/v1/bp', (route) => route.fulfill({ json: snapshot }));
    await page.route('**/bp-media/empty.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
      }),
    );
    await page.route('**/bp-media/missing.webp', (route) => route.abort());
    await page.route('**/bp-media/valid.webp', async (route) =>
      route.fulfill({
        contentType: 'image/webp',
        body: await readFile('apps/web/public/fixture-media/epl-s24/epl-falcons.webp'),
      }),
    );
    await page.goto('/program/bp');
    for (const entrant of ['a', 'b']) {
      const team = page.locator(`.bp-team[data-entrant="${entrant}"]`);
      await expect(team.getByRole('img', { name: /队标不可用/ })).toBeVisible();
      await expect(team.locator('img')).toHaveCount(0);
    }
    const before = await page.locator('.bp-card').evaluateAll((cards) =>
      cards.map((card) => {
        const { x, y, width, height } = card.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    for (const card of await page.locator('.bp-card').all()) {
      const bounds = (await card.boundingBox())!;
      for (const content of await card.locator('h2, .bp-badge, .bp-owner, .bp-side-choice').all()) {
        const box = (await content.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.y).toBeGreaterThanOrEqual(bounds.y);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
      }
    }
    snapshot = {
      ...snapshot,
      revision: 'media-2',
      projection: {
        ...projection,
        entrants: {
          a: { ...projection.entrants.a, logoUrl: '/bp-media/valid.webp' },
          b: { ...projection.entrants.b, logoUrl: null },
        },
      },
    };
    const logo = page.locator('.bp-team[data-entrant="a"] img');
    await expect(logo).toBeVisible();
    await expect
      .poll(() => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(
      page.locator('.bp-team[data-entrant="a"]').getByRole('img', { name: /队标不可用/ }),
    ).toHaveCount(0);
    await expect(
      page.locator('.bp-team[data-entrant="b"]').getByRole('img', { name: /队标不可用/ }),
    ).toBeVisible();
    expect(
      await page.locator('.bp-card').evaluateAll((cards) =>
        cards.map((card) => {
          const { x, y, width, height } = card.getBoundingClientRect();
          return { x, y, width, height };
        }),
      ),
    ).toEqual(before);
  } finally {
    await app.close();
  }
});
