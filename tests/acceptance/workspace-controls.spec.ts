import { readFileSync } from 'node:fs';
import type { WebSocketRoute } from '@playwright/test';
import { radarSnapshotSchema } from '../../packages/protocol/src/radar.js';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';
import { expect, test } from './companion-isolation.js';

test('four product entries lead to the current match, library, HUD resources and settings', async ({
  page,
}) => {
  await page.goto('/');
  for (const [label, path, title] of [
    ['比赛库', '/resources', '比赛库'],
    ['HUD', '/resources?tab=hud', 'HUD'],
    ['设置', '/settings', '本机设置'],
    ['本场', '/', '本场准备'],
  ] as const) {
    await page
      .getByRole('navigation', { name: '制作导航' })
      .getByRole('link', { name: label, exact: true })
      .click();
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
  }
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
  let connection = 'connected';
  await page.route('**/local/v1/obs', (r) =>
    r.fulfill({
      json: {
        connection,
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
  expect(requests.some((request) => request.path.endsWith('/ensure'))).toBe(false);
  await expect(page.getByRole('button', { name: '检查配置', exact: true })).toHaveCount(0);
  const evidence = process.env.MIZAR_REVIEW_FIXTURE_SCREENSHOTS;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, 'obs-connected-contract-fixture.png'),
      fullPage: false,
    });
  }
  await page.locator('summary').filter({ hasText: 'WebSocket 连接设置' }).click();
  await page.getByLabel('WebSocket 端口').fill('4466');
  await page.getByLabel('WebSocket 密码').fill('ui-test-password');
  await page.getByLabel('WebSocket 密码').focus();
  connection = 'unavailable';
  await page.waitForTimeout(3200);
  connection = 'connected';
  await page.waitForTimeout(3200);
  await expect(page.getByLabel('WebSocket 密码')).toBeFocused();
  await expect(page.getByLabel('WebSocket 密码')).toHaveValue('ui-test-password');
  if (evidence)
    await page.screenshot({
      path: join(evidence, 'obs-editing-contract-fixture.png'),
      fullPage: false,
    });
  await page.getByRole('button', { name: '保存并测试', exact: true }).click();
  await expect
    .poll(() => requests)
    .toContainEqual({
      path: '/operator/obs/configure',
      body: { port: 4466, password: 'ui-test-password' },
    });
  await expect(page.getByLabel('WebSocket 密码')).toHaveValue('');
  await expect.poll(() => requests.at(-1)).toEqual({ path: '/operator/obs/check', body: {} });
  await page.getByRole('button', { name: '修复 Mizar 场景', exact: true }).click();
  await expect.poll(() => requests.at(-1)).toEqual({ path: '/operator/obs/repair', body: {} });
  await page.getByRole('button', { name: '添加默认桌面音频与麦克风', exact: true }).click();
  await expect.poll(() => requests).toContainEqual({ path: '/operator/obs/audio-setup', body: {} });
  await expect(page.getByText('已添加系统默认桌面音频与麦克风。', { exact: false })).toBeVisible();
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
  await expect(
    page.getByRole('button', { name: '添加默认桌面音频与麦克风', exact: true }),
  ).toBeDisabled();
});

test('map-pool saving reaches the real tournament service', async ({ page, context }) => {
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
    await page.goto('/resources?tab=event');
    const train = page.getByRole('checkbox', { name: 'Train', exact: true });
    await train.check();
    page.once('dialog', (dialog) => dialog.accept());
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
    await page.getByRole('button', { name: '观战 / 本机 HUD', exact: true }).click();
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
  await page.getByRole('button', { name: '观战 / 本机 HUD', exact: true }).click();
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
  const preview = page.locator('.workspace-next-summary');
  await expect(preview).toContainText('半场');
  expect(commands).toEqual([]);
  next = null;
  await expect(preview.locator('iframe')).toHaveCount(0);
  await expect(preview).toContainText('待确认');
  await expect(preview).toContainText('预计下一节目');
  next = 'halftime';
  mode = 'manual';
  await expect(page.getByText('手动保持', { exact: true })).toBeVisible();
  await expect(preview).toContainText('半场');
  await expect(preview).toContainText('预计下一节目');
  expect(commands).toEqual([]);
  for (const scene of PROGRAM_SCENES) {
    await page.getByRole('button', { name: scene.title, exact: true }).click();
    await expect
      .poll(() => commands.at(-1))
      .toEqual({ sceneId: scene.id, expectedRevision: 'next-1' });
  }
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
    ['HUD 编辑器', 'open_tool', { tool: 'hud' }],
    ['正式 BP', 'open_tool', { tool: 'bp' }],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { auditCalls: unknown[] }).auditCalls))
      .toContainEqual({ command, args });
  }
  for (const [label, action] of [
    ['隐藏工作区', 'hide'],
    ['结束制播', 'finish'],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (action === 'finish') await page.getByRole('button', { name: '确认结束并恢复配置' }).click();
    await expect.poll(() => lifecycle.at(-1)).toEqual({ action, expectedRevision: 'production-1' });
  }
});

test('local recovery preserves scene controls and website source is never automatically reclaimed after stop or remount', async ({
  page,
}) => {
  let source: string | null = 'match-1';
  const commands: string[] = [];
  await page.route('**/local/v1/rivalhub-connection', (route) =>
    route.fulfill({
      json: {
        paired: true,
        activeMatchId: 'match-1',
        activeSourceMatchId: source,
        sourceReady: true,
      },
    }),
  );
  await page.route('**/operator/rivalhub/source/*', (route) => {
    const name = new URL(route.request().url()).pathname;
    commands.push(name);
    if (name.endsWith('release')) source = null;
    else source = 'match-1';
    return route.fulfill({ json: { paired: true, activeSourceMatchId: source } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '现场恢复', exact: true }).click();
  await expect(page.getByRole('region', { name: '原位恢复面板' })).toBeVisible();
  await expect(page.getByRole('button', { name: '对阵', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止提供网站数据', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复提供网站数据', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起恢复' }).click();
  await page.getByRole('button', { name: '现场恢复', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复提供网站数据', exact: true })).toBeVisible();
  expect(commands).toEqual(['/operator/rivalhub/source/release']);
  await page.getByRole('button', { name: '恢复提供网站数据', exact: true }).click();
  expect(commands).toEqual([
    '/operator/rivalhub/source/release',
    '/operator/rivalhub/source/claim',
  ]);
});

for (const outcome of ['true', 'false', 'reject'] as const) {
  test(`scene confirmation survives focus restoration ${outcome} and BP never steals focus`, async ({
    page,
  }) => {
    const calls: string[] = [];
    await page.exposeFunction('recordFocus', (command: string) => {
      calls.push(command);
    });
    await page.addInitScript((result) => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            await (
              window as unknown as { recordFocus: (command: string) => Promise<void> }
            ).recordFocus(command);
            if (command === 'restore_cs2_focus') {
              if (result === 'reject') throw new Error('窗口不可用，请手动切回游戏。');
              return result === 'true';
            }
            return true;
          },
        },
      });
    }, outcome);
    await page.route('**/local/v1/program-scenes', (route) =>
      route.fulfill({
        json: {
          schemaVersion: 'mizar.program-scenes.v1',
          active: 'waiting',
          revision: 'focus-1',
          available: PROGRAM_SCENES.map((scene) => scene.id),
          blocked: {},
        },
      }),
    );
    await page.route('**/operator/program-scene', (route) => route.fulfill({ json: { ok: true } }));
    await page.goto('/workspace');
    await page.getByRole('button', { name: '比赛中', exact: true }).click();
    await expect(page.locator('.workspace-message')).toContainText('节目切换已确认');
    await expect(page.locator('.workspace-message [role="alert"]')).toHaveCount(0);
    await expect(page.locator('.workspace-message')).toContainText(
      outcome === 'true' ? '焦点已恢复' : outcome === 'false' ? '未接受焦点恢复' : '焦点恢复未完成',
    );
    expect(calls.filter((command) => command === 'restore_cs2_focus')).toHaveLength(1);
    await page.getByRole('button', { name: 'BP', exact: true }).click();
    expect(calls.filter((command) => command === 'restore_cs2_focus')).toHaveLength(1);
  });
}

test('recovery preserves the radar area and makes the complete long command error keyboard accessible', async ({
  page,
}) => {
  const message = 'OBS 场景切换与回退均未能确认；实际播出场景无法确认，请检查 OBS。'.repeat(6);
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'waiting',
        revision: 'error-1',
        available: PROGRAM_SCENES.map((scene) => scene.id),
        blocked: {},
      },
    }),
  );
  await page.route('**/operator/program-scene', (route) =>
    route.fulfill({ status: 409, json: { message } }),
  );
  const artifact = JSON.parse(
    readFileSync(
      'apps/web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
      'utf8',
    ),
  ) as { fixtures: Record<string, { samples: { snapshot: unknown }[] }> };
  const snapshot = radarSnapshotSchema.parse(
    artifact.fixtures['dense-utility']!.samples[0]!.snapshot,
  );
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/local/v1/radar', (route) => {
    socket = route;
    route.send(JSON.stringify(snapshot));
  });
  await page.goto('/workspace');
  await expect(page.getByText('比赛数据正常', { exact: true })).toBeVisible();
  const canvas = page.locator('.workspace-radar canvas').first();
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => element.setAttribute('data-review-mounted', 'true'));
  const radar = page.getByRole('region', { name: '比赛雷达' });
  const marker = await radar.evaluate((element) => {
    element.setAttribute('data-review-mounted', 'true');
    return element.getBoundingClientRect().height;
  });
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect(page.locator('.workspace-message')).toContainText(message);
  await page.getByRole('button', { name: '现场恢复', exact: true }).click();
  await expect(radar).toHaveAttribute('data-review-mounted', 'true');
  await expect(canvas).toHaveAttribute('data-review-mounted', 'true');
  expect(await radar.evaluate((element) => element.getBoundingClientRect().height)).toBe(marker);
  const detail = page.locator('.workspace-recovery__detail');
  await expect(detail).toHaveText(message);
  await detail.focus();
  await expect(detail).toBeFocused();
  await expect(page.getByRole('button', { name: '比赛中', exact: true })).toBeVisible();
  if (process.env.MIZAR_REVIEW_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.MIZAR_REVIEW_SCREENSHOTS}/recovery-long-error.png`,
    });
  snapshot.channelSeq += 1;
  snapshot.payload.telemetryFreshness = 'stale';
  socket?.send(JSON.stringify(snapshot));
  await expect(page.locator('.workspace-radar canvas')).toHaveCount(0);
  await expect(page.getByText('等待 GSI 数据', { exact: true })).toBeVisible();
});

test('OBS actual scene and recording use service truth, and read failure never means stopped output', async ({
  page,
}) => {
  let connected = true;
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'waiting',
        revision: 'obs-1',
        available: PROGRAM_SCENES.map((scene) => scene.id),
        blocked: {},
      },
    }),
  );
  await page.route('**/local/v1/obs', (route) =>
    connected
      ? route.fulfill({
          json: {
            connection: 'connected',
            currentScene: 'Emergency · 人工应急画面',
            sceneAligned: false,
            streaming: true,
            recording: true,
            port: 4455,
            passwordConfigured: true,
            findings: [],
            video: null,
          },
        })
      : route.fulfill({ status: 503 }),
  );
  await page.goto('/workspace/dock');
  await expect(page.locator('.workspace-direction')).toContainText('Mizar 确认 · 赛前等待');
  await expect(page.locator('.workspace-obs-scene')).toContainText('Emergency · 人工应急画面');
  await expect(page.locator('.workspace-obs-scene')).toContainText('与 Mizar 不一致');
  await expect(page.locator('.workspace-production')).toContainText('推流中 / 录制中');
  connected = false;
  await expect(page.locator('.workspace-production')).toContainText('输出无法确认');
  await expect(page.locator('.workspace-obs-scene')).toContainText('对齐未知');
  await expect(page.locator('.workspace-production')).not.toContainText('未推流');
});
