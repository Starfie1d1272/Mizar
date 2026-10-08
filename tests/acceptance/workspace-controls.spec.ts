import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { toMatchDocumentV1 } from '../../packages/rivalhub/src/index.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';
import { expect, test } from './companion-isolation.js';

test('sidebar links and preparation tools open their actual destinations', async ({
  page,
  context,
}) => {
  await page.goto('/');
  for (const [label, path, heading] of [
    ['比赛资料', '/matches', '比赛资料'],
    ['播出画面', '/picture', '播出画面'],
    ['游戏设置', '/settings?tab=gsi', '游戏设置'],
    ['OBS 连接', '/settings?tab=obs', 'OBS 连接'],
    ['赛事平台', '/settings?tab=rivalhub', '赛事平台'],
    ['高级设置', '/settings?tab=advanced', '高级设置'],
    ['总览', '/', '总览'],
  ] as const) {
    await page.locator('.product-sidebar').getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path.replace('?', '\\?')}$`));
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  for (const [label, path] of [
    ['HUD 编辑器', '/operator/hud'],
    ['BP 工作台', '/preview?scene=bp'],
    ['节目预览', '/preview'],
    ['运行诊断', '/debug'],
  ] as const) {
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: label, exact: true }).click();
    const tool = await opened;
    await tool.waitForLoadState('domcontentloaded');
    expect(new URL(tool.url()).pathname + new URL(tool.url()).search).toBe(path);
    await expect(tool.locator('body')).not.toBeEmpty();
    await tool.close();
  }
  await page.getByRole('button', { name: '新建本地比赛', exact: true }).click();
  await expect(page).toHaveURL(/\/matches\?createLocal=1#local-match$/);
  await expect(page.getByRole('button', { name: '创建本地比赛', exact: true })).toBeVisible();
});

test('OBS setup buttons launch the configured target, configure, check and repair with the correct commands', async ({
  page,
}) => {
  const native: unknown[] = [];
  await page.exposeFunction('recordObsNative', (value: unknown) => {
    native.push(value);
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: unknown) => {
          await (
            window as unknown as {
              recordObsNative: (value: unknown) => Promise<void>;
            }
          ).recordObsNative({ command, args: args ?? null });
          if (command === 'select_obs_executable') return 'C:\\OBS\\obs64.exe';
          return {};
        },
      },
    });
  });
  let streaming = false;
  await page.route('**/local/v1/obs', (r) =>
    r.fulfill({
      json: {
        connection: 'connected',
        currentScene: 'Mizar · 比赛中',
        port: 4455,
        passwordConfigured: true,
        streaming,
        recording: false,
        video: null,
        findings: [],
        sceneAligned: true,
      },
    }),
  );
  const requests: { path: string; body: unknown }[] = [];
  await page.route('**/operator/obs/*', (r) => {
    const path = new URL(r.request().url()).pathname;
    requests.push({ path, body: r.request().postDataJSON() });
    return r.fulfill({
      json: path.endsWith('launch-target')
        ? { executablePath: 'C:\\ConfiguredOBS\\obs64.exe' }
        : { findings: [] },
    });
  });
  await page.goto('/settings?tab=obs');
  await page.getByRole('button', { name: '打开 OBS', exact: true }).click();
  await expect
    .poll(() => native)
    .toContainEqual({
      command: 'launch_obs',
      args: { executablePath: 'C:\\ConfiguredOBS\\obs64.exe' },
    });
  await page.getByLabel('WebSocket 端口').fill('4466');
  await page.getByLabel('WebSocket 密码').fill('ui-test-password');
  await page.getByRole('button', { name: '保存并测试', exact: true }).click();
  await expect
    .poll(() => requests)
    .toContainEqual({
      path: '/operator/obs/configure',
      body: { port: 4466, password: 'ui-test-password' },
    });
  await expect(page.getByLabel('WebSocket 密码')).toHaveValue('');
  await page.getByRole('button', { name: '检查配置', exact: true }).click();
  await expect.poll(() => requests.at(-1)).toEqual({ path: '/operator/obs/check', body: {} });
  await page.getByRole('button', { name: '修复 Mizar 场景', exact: true }).click();
  await expect.poll(() => requests.at(-1)).toEqual({ path: '/operator/obs/repair', body: {} });
  await page.locator('summary').filter({ hasText: 'OBS 路径' }).click();
  await page.getByRole('button', { name: '更改 OBS 路径', exact: true }).click();
  await expect
    .poll(() => requests.at(-1))
    .toEqual({ path: '/operator/obs/configure', body: { executablePath: 'C:\\OBS\\obs64.exe' } });
  await page.locator('summary').filter({ hasText: '已保存密码' }).click();
  await page.getByRole('button', { name: '清除已保存密码', exact: true }).click();
  await expect
    .poll(() => requests)
    .toContainEqual({ path: '/operator/obs/configure', body: { port: 4466, password: '' } });
  streaming = true;
  await page.reload();
  await expect(page.getByRole('button', { name: '修复 Mizar 场景', exact: true })).toBeDisabled();
});

test('map-pool checkboxes stay adjacent to their labels and saving reaches the real tournament service', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-map-pool-ui-'));
  const app = buildApp({
    localTournamentPath: join(directory, 'tournament.json'),
    matchManifestPath: join(directory, 'match.json'),
  });
  try {
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { teamA: '测试 A', teamB: '测试 B', format: 'bo3' },
    });
    expect(created.statusCode).toBe(200);
    await context.route(/\/(?:local\/v1\/|operator\/local-)/, async (r) => {
      const response = await app.inject({
        method: r.request().method() === 'POST' ? 'POST' : 'GET',
        url: new URL(r.request().url()).pathname,
        headers: { origin: 'http://127.0.0.1:3000' },
        ...(r.request().method() === 'POST'
          ? { payload: r.request().postDataJSON() as Record<string, unknown> }
          : {}),
      });
      await r.fulfill({
        status: response.statusCode,
        body: response.body,
        contentType: 'application/json',
      });
    });
    await page.goto('/matches?tab=maps');
    const train = page.getByRole('checkbox', { name: 'Train', exact: true });
    await train.check();
    const labelGap = await train.evaluate((input) => {
      const checkbox = input.getBoundingClientRect();
      const label = input.parentElement!.querySelector('span')!.getBoundingClientRect();
      return label.left - checkbox.right;
    });
    expect(labelGap).toBeLessThanOrEqual(12);
    await page.getByRole('button', { name: '保存赛事资料', exact: true }).click();
    await expect(page.getByText('赛事资料已保存。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(train).toBeChecked();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local HUD toggles use the real service, preserve independence and leave on-air config unchanged', async ({
  page,
  context,
}) => {
  const app = buildApp();
  try {
    await app.ready();
    const onAir = (await app.inject('/local/v1/hud-config')).body;
    await context.route(
      /\/(?:local\/v1\/desktop-overlay|operator\/desktop-overlay)$/,
      async (route) => {
        const r = await app.inject({
          method: route.request().method() === 'POST' ? 'POST' : 'GET',
          url: new URL(route.request().url()).pathname,
          headers: { origin: 'http://127.0.0.1:3000' },
          ...(route.request().method() === 'POST'
            ? { payload: route.request().postDataJSON() as Record<string, unknown> }
            : {}),
        });
        await route.fulfill({
          status: r.statusCode,
          body: r.body,
          contentType: 'application/json',
        });
      },
    );
    await page.goto('/workspace/dock');
    const radar = page.getByRole('button', { name: '雷达', exact: true });
    const hud = page.getByRole('button', { name: '其他 HUD', exact: true });
    await expect(radar).toHaveAttribute('aria-pressed', 'false');
    await expect(hud).toHaveAttribute('aria-pressed', 'true');
    for (const [button, radarOn, hudOn] of [
      [radar, true, true],
      [hud, true, false],
      [radar, false, false],
      [hud, false, true],
    ] as const) {
      await button.click();
      await expect(radar).toHaveAttribute('aria-pressed', String(radarOn));
      await expect(hud).toHaveAttribute('aria-pressed', String(hudOn));
      expect((await app.inject('/local/v1/hud-config')).body).toBe(onAir);
    }
  } finally {
    await app.close();
  }
});

test('HUD command copy confirms copying, and clipboard failure retains the exact manual command', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/workspace/dock');
  for (const [label, value] of [
    ['复制隐藏命令', '1'],
    ['复制恢复命令', '0'],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `cl_draw_only_deathnotices ${value}`,
    );
    await expect(page.locator('.workspace-message')).toContainText('已复制，尚未执行');
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new Error('denied')),
    });
  });
  await page.getByRole('button', { name: '复制隐藏命令', exact: true }).click();
  await expect(page.locator('.workspace-message')).toContainText(
    '复制未完成，手动复制：cl_draw_only_deathnotices 1',
  );
});

test('next scene uses the registered Program renderer, never guesses or takes a scene', async ({
  page,
}) => {
  let next: string | null = 'halftime';
  let mode = 'auto';
  const commands: unknown[] = [];
  await page.route('**/local/v1/program-scenes', (r) =>
    r.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'gameplay',
        revision: 'next-1',
        available: PROGRAM_SCENES.map((s) => s.id),
        blocked: {},
        director: { mode, next, reason: null, introDurationMs: 6000, sceneElapsedMs: 0 },
      },
    }),
  );
  await page.route('**/operator/program-scene', (r) => {
    commands.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace/dock');
  const preview = page.locator('.workspace-next-preview');
  await expect(preview.locator('iframe')).toHaveAttribute('src', '/program/halftime');
  await expect(preview.frameLocator('iframe').locator('.program-scene--halftime')).toBeVisible();
  expect(commands).toEqual([]);
  next = null;
  await expect(preview.locator('iframe')).toHaveCount(0);
  await expect(preview).toContainText('待确认');
  await expect(preview).toContainText('等待编排数据');
  next = 'halftime';
  mode = 'manual';
  await expect(page.getByText('手动保持', { exact: true })).toBeVisible();
  await expect(preview.locator('iframe')).toHaveAttribute('src', '/program/halftime');
  await expect(preview).toContainText('恢复自动后建议进入');
  expect(commands).toEqual([]);
  for (const scene of PROGRAM_SCENES) {
    await page.getByRole('button', { name: scene.title, exact: true }).click();
    await expect
      .poll(() => commands.at(-1))
      .toEqual({ sceneId: scene.id, expectedRevision: 'next-1' });
  }
});

test('overview focuses on match preparation and OBS image occupies the bottom at 16:9', async ({
  page,
}) => {
  const document = toMatchDocumentV1(
    JSON.parse(
      await readFile('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json', 'utf8'),
    ),
  );
  await page.route('**/local/v1/match-document', (r) =>
    r.fulfill({ json: { document, source: 'rivalhub', freshness: 'fresh' } }),
  );
  await page.goto('/');
  const match = await page.locator('.preparation-match').boundingBox();
  const checks = await page.locator('.preparation-overview').boundingBox();
  expect(checks!.x).toBeGreaterThan(match!.x);
  expect(checks!.y).toBeCloseTo(match!.y, 0);
  await expect(page.getByRole('button', { name: '复制隐藏命令', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制恢复命令', exact: true })).toHaveCount(0);
  await expect(page.locator('.local-overlay-controls')).toHaveCount(0);
  await page.goto('/workspace/left');
  const obs = await page.locator('.workspace-confidence').boundingBox();
  expect(obs!.width / obs!.height).toBeCloseTo(16 / 9, 2);
  expect(obs!.y + obs!.height).toBeCloseTo(1080, 0);
  await expect(page.locator('.workspace-confidence')).toContainText('OBS 预览暂不可用');
  await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeVisible();
});

test('desktop tool buttons dispatch the intended windows and lifecycle actions', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, {
      auditCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) => {
          calls.push({ command, args: args ?? null });
          return Promise.resolve(true);
        },
      },
    });
  });
  await page.route('**/local/v1/production', (r) =>
    r.fulfill({ json: { mode: 'live', revision: 'production-1', canEnter: true } }),
  );
  const lifecycle: unknown[] = [];
  await page.route('**/operator/production', (r) => {
    lifecycle.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  for (const [label, command, args] of [
    ['比赛资料', 'open_main', { path: '/matches' }],
    ['检查游戏连接', 'open_main', { path: '/settings?tab=gsi' }],
    ['OBS 配置', 'open_main', { path: '/settings?tab=obs' }],
    ['HUD 编辑器', 'open_tool', { tool: 'hud' }],
    ['运行诊断', 'open_tool', { tool: 'diagnostics' }],
    ['BP 工作台', 'open_tool', { tool: 'bp' }],
    ['恢复布局', 'restore_layout', null],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { auditCalls: unknown[] }).auditCalls))
      .toContainEqual({ command, args });
  }
  for (const [label, action] of [
    ['隐藏工作区', 'hide'],
    ['退出工作台', 'finish'],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => lifecycle.at(-1)).toEqual({ action, expectedRevision: 'production-1' });
  }
});
