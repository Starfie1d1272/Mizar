import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';
import { expect, test } from './companion-isolation.js';
import { randomUUID } from 'node:crypto';
import type { ObsOutputCommand, ObsOutputsStatus } from '../../packages/protocol/src/obs.js';

for (const [width, height] of [
  [1440, 270],
  [1024, 192],
  [960, 180],
  [682, 128],
  [618, 116],
] as const) {
  test(`OBS stop confirmation fits the independent Host dock ${width}×${height}`, async ({
    page,
  }) => {
    // geometry.rs: 75% cap and integer 16:9 game; full-screen at 100% / 150%,
    // plus the 1366×768 work-area fallback at 150% with a 48-logical-pixel taskbar.
    await page.setViewportSize({ width, height });
    const status: ObsOutputsStatus = {
      stream: { active: true, phase: 'active', pending: null, revision: randomUUID() },
      record: { active: true, phase: 'active', pending: null, revision: randomUUID() },
    };
    const calls: ObsOutputCommand[] = [];
    await page.route('**/local/v1/obs/outputs', (route) => route.fulfill({ json: status }));
    await page.route('**/operator/obs/output', (route) => {
      calls.push(route.request().postDataJSON() as ObsOutputCommand);
      return route.fulfill({ status: 409, json: { message: '模拟验证，未执行 OBS 操作。' } });
    });
    await page.goto('/workspace/dock');
    await page.getByRole('button', { name: '停止直播', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    expect(
      await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          element.scrollHeight <= element.clientHeight + 1 &&
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight &&
          [...element.querySelectorAll('button')].every((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.top >= bounds.top &&
              rect.bottom <= bounds.bottom &&
              rect.left >= bounds.left &&
              rect.right <= bounds.right
            );
          })
        );
      }),
    ).toBe(true);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(calls).toHaveLength(0);
    await page.getByRole('button', { name: '停止直播', exact: true }).click();
    await page.getByRole('button', { name: '确认停止', exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ output: 'stream', action: 'stop' });
  });
}

test('OBS output controls confirm actual state, protect stop, and reflect external changes', async ({
  page,
}) => {
  let outputs: ObsOutputsStatus = {
    stream: { active: false, phase: 'idle', pending: null, revision: randomUUID() },
    record: { active: true, phase: 'paused', pending: null, revision: randomUUID() },
  };
  let online = true;
  const calls: ObsOutputCommand[] = [];
  let release!: () => void;
  await page.route('**/local/v1/obs/outputs', (route) =>
    route.fulfill({ status: online ? 200 : 503, json: outputs }),
  );
  await page.route('**/operator/obs/output', async (route) => {
    const command = route.request().postDataJSON() as ObsOutputCommand;
    calls.push(command);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    outputs = {
      ...outputs,
      [command.output]: {
        active: command.action === 'start',
        phase: command.action === 'start' ? 'active' : 'idle',
        pending: null,
        revision: randomUUID(),
      },
    };
    await route.fulfill({ json: { ok: true, outputs } });
  });
  await page.goto('/workspace/dock');
  await page.getByRole('button', { name: '开始直播', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始直播中…' })).toBeDisabled();
  await expect.poll(() => calls.length).toBe(1);
  release();
  await page.getByRole('button', { name: '停止直播', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('停止 OBS 直播');
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: '停止直播', exact: true }).click();
  await page.getByRole('button', { name: '确认停止', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toMatchObject({ output: 'stream', action: 'stop' });
  release();
  await expect(page.getByRole('button', { name: '开始直播', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂停 · 停止', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('停止 OBS 录像');
  outputs = {
    ...outputs,
    record: { active: false, phase: 'idle', pending: null, revision: randomUUID() },
  };
  await expect(page.getByRole('button', { name: '确认停止', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始录像', exact: true })).toBeEnabled();
  online = false;
  await expect(page.getByRole('button', { name: '直播待确认', exact: true })).toBeDisabled();
  online = true;
  outputs = {
    ...outputs,
    stream: { active: true, phase: 'reconnecting', pending: null, revision: randomUUID() },
  };
  await expect(page.getByRole('button', { name: '重连 · 停止', exact: true })).toBeEnabled();
  expect(calls).toHaveLength(2);
});

test('OBS unconfirmed output error stays actionable without automatically resending', async ({
  page,
}) => {
  const outputs = {
    stream: { active: false, phase: 'idle', pending: null, revision: randomUUID() },
    record: { active: false, phase: 'idle', pending: null, revision: randomUUID() },
  };
  let calls = 0;
  await page.route('**/local/v1/obs/outputs', (route) => route.fulfill({ json: outputs }));
  await page.route('**/operator/obs/output', (route) => {
    calls++;
    return route.fulfill({
      status: 409,
      json: {
        error: 'obs_output_unconfirmed',
        message: '操作结果尚未确认，请等待 OBS 重新连接后核对。',
      },
    });
  });
  await page.goto('/workspace/dock');
  await page.getByRole('button', { name: '开始录像', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('button', { name: '开始录像', exact: true })).toBeEnabled();
  expect(calls).toBe(1);
});

// These fields are injected by addInitScript into Playwright's browser realm.
// Cross through unknown at that boundary: the root test project also declares
// a jsdom Window, which is distinct from the browser's Window type.
type WorkspaceTestWindow = {
  focusAudit: string[];
  auditCalls: unknown[];
  focusResult: boolean;
  completeLayout: () => void;
};

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
  await page.getByRole('button', { name: '创建本地比赛', exact: true }).click();
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
  let sceneRepairNeeded = false;
  const findings = () =>
    sceneRepairNeeded ? [{ code: 'scene_missing', message: '缺少 Mizar 场景' }] : [];
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
        findings: findings(),
        sceneAligned: true,
      },
    }),
  );
  const requests: { path: string; body: unknown }[] = [];
  await page.route('**/operator/obs/*', (r) => {
    const path = new URL(r.request().url()).pathname;
    requests.push({ path, body: r.request().postDataJSON() });
    if (path.endsWith('/repair')) sceneRepairNeeded = false;
    return r.fulfill({
      json: path.endsWith('launch-target')
        ? { executablePath: 'C:\\ConfiguredOBS\\obs64.exe' }
        : { findings: findings() },
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
  await expect.poll(() => requests).toContainEqual({ path: '/operator/obs/ensure', body: {} });
  await expect(page.getByRole('button', { name: '检查配置', exact: true })).toHaveCount(0);
  await page.locator('summary').filter({ hasText: 'WebSocket 连接设置' }).click();
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
  await expect.poll(() => requests.at(-1)).toEqual({ path: '/operator/obs/check', body: {} });
  const repair = page.getByRole('button', { name: '一键修复 Mizar 场景', exact: true });
  await expect(repair).toHaveCount(0);
  sceneRepairNeeded = true;
  await expect(repair).toBeVisible();
  await repair.click();
  await expect.poll(() => requests).toContainEqual({ path: '/operator/obs/repair', body: {} });
  await expect
    .poll(() => requests[requests.findIndex((item) => item.path === '/operator/obs/repair') + 1])
    .toEqual({ path: '/operator/obs/check', body: {} });
  await expect(repair).toHaveCount(0);
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
  sceneRepairNeeded = true;
  await page.reload();
  await expect(
    page.getByRole('button', { name: '一键修复 Mizar 场景', exact: true }),
  ).toBeDisabled();
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
    await page.goto('/matches?tab=maps');
    const train = page.getByRole('checkbox', { name: 'Train', exact: true });
    await train.check();
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
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, {
      focusAudit: calls,
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command === 'cs2_config_status') return Promise.resolve({ phase: 'running' });
          if (command === 'workspace_exit_status')
            return Promise.resolve({ busy: false, stage: '', message: null });
          calls.push(command);
          return Promise.resolve(true);
        },
      },
    });
  });
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
  await expect(preview.locator('small')).toHaveText('下一场景');
  next = 'halftime';
  mode = 'manual';
  await expect(page.getByText('手动保持', { exact: true })).toBeVisible();
  await expect(preview.locator('iframe')).toHaveAttribute('src', '/program/halftime');
  await expect(preview.locator('small')).toHaveText('下一场景');
  expect(commands).toEqual([]);
  for (const scene of PROGRAM_SCENES) {
    await page.getByRole('button', { name: scene.title, exact: true }).click();
    await expect
      .poll(() => commands.at(-1))
      .toEqual({ sceneId: scene.id, expectedRevision: 'next-1' });
    await expect(page.getByRole('button', { name: scene.title, exact: true })).toBeEnabled();
    expect(
      await page.evaluate(() => (window as unknown as WorkspaceTestWindow).focusAudit),
    ).not.toContain('restore_cs2_focus');
  }
});

test('desktop tool buttons dispatch the intended windows and lifecycle actions', async ({
  page,
}) => {
  await page.route('**/local/v1/demo-test', (route) =>
    route.fulfill({ json: { active: false, phase: 'idle' } }),
  );
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, {
      auditCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) => {
          if (command === 'cs2_config_status') return Promise.resolve({ phase: 'running' });
          if (command === 'workspace_exit_status')
            return Promise.resolve({ busy: false, stage: '', message: null });
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
  expect(await page.evaluate(() => (window as unknown as WorkspaceTestWindow).auditCalls)).toEqual([
    { command: 'open_main', args: { path: '/matches' } },
    { command: 'open_main', args: { path: '/settings?tab=gsi' } },
    { command: 'open_main', args: { path: '/settings?tab=obs' } },
    { command: 'open_tool', args: { tool: 'hud' } },
    { command: 'open_tool', args: { tool: 'diagnostics' } },
    { command: 'open_tool', args: { tool: 'bp' } },
    { command: 'restore_layout', args: null },
  ]);
  await page.getByRole('button', { name: '隐藏工作区', exact: true }).click();
  await expect
    .poll(() => lifecycle.at(-1))
    .toEqual({ action: 'hide', expectedRevision: 'production-1' });
  await page.getByRole('button', { name: '退出工作台', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as WorkspaceTestWindow).auditCalls))
    .toContainEqual({ command: 'finish_workspace', args: null });
  expect(lifecycle).toHaveLength(1);
});

test('delayed panel actions never return focus; only explicit return to game invokes the Host', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, {
      focusAudit: calls,
      focusResult: false,
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command === 'cs2_config_status') return Promise.resolve({ phase: 'running' });
          if (command === 'workspace_exit_status')
            return Promise.resolve({ busy: false, stage: '', message: null });
          calls.push(command);
          if (command === 'restore_layout')
            return new Promise<void>((resolve) => {
              (window as unknown as WorkspaceTestWindow).completeLayout = resolve;
            });
          return Promise.resolve((window as unknown as WorkspaceTestWindow).focusResult);
        },
      },
    });
  });
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'waiting',
        revision: 'focus-1',
        available: PROGRAM_SCENES.map((scene) => scene.id),
        blocked: {},
        director: {
          mode: 'manual',
          next: null,
          reason: null,
          introDurationMs: 3000,
          sceneElapsedMs: 0,
        },
      },
    }),
  );
  let completeScene: (() => void) | undefined;
  const scenes: unknown[] = [];
  await page.route('**/operator/program-scene', async (route) => {
    scenes.push(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      completeScene = resolve;
    });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace/dock');
  const returnToGame = page.getByRole('button', { name: '返回游戏', exact: true });
  await expect(returnToGame).toBeEnabled();
  const otherApp = await context.newPage();
  await otherApp.setContent('<input aria-label="Other application notes">');
  for (const sceneId of ['gameplay', 'bp'] as const) {
    const scene = PROGRAM_SCENES.find((item) => item.id === sceneId)!;
    await page.getByRole('button', { name: scene.title, exact: true }).click();
    await expect.poll(() => scenes.at(-1)).toEqual({ sceneId, expectedRevision: 'focus-1' });
    await expect(returnToGame).toBeDisabled();
    await otherApp.bringToFront();
    await otherApp.getByRole('textbox').fill('Operator selected another application');
    completeScene!();
    await expect(returnToGame).toBeEnabled();
    expect(
      await page.evaluate(() => (window as unknown as WorkspaceTestWindow).focusAudit),
    ).toEqual([]);
  }
  await page.getByRole('button', { name: '恢复布局', exact: true }).click();
  await expect(returnToGame).toBeDisabled();
  await otherApp.bringToFront();
  await page.evaluate(() => (window as unknown as WorkspaceTestWindow).completeLayout());
  await expect(returnToGame).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as WorkspaceTestWindow).focusAudit)).toEqual([
    'restore_layout',
  ]);
  await otherApp.close();
  // A keyboard activation is the sole focus request, and a declined Host
  // request leaves the existing visible feedback instead of retrying later.
  await returnToGame.focus();
  await returnToGame.press('Enter');
  await expect(page.getByText('操作已完成，未能将焦点交还 CS2。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as WorkspaceTestWindow).focusAudit)).toEqual([
    'restore_layout',
    'restore_cs2_focus',
  ]);
  await page.evaluate(() => ((window as unknown as WorkspaceTestWindow).focusResult = true));
  await returnToGame.click();
  await expect(returnToGame).toBeEnabled();
  await expect(page.getByText('操作已完成，未能将焦点交还 CS2。', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as WorkspaceTestWindow).focusAudit)).toEqual([
    'restore_layout',
    'restore_cs2_focus',
    'restore_cs2_focus',
  ]);
  expect(scenes).toEqual([
    { sceneId: 'gameplay', expectedRevision: 'focus-1' },
    { sceneId: 'bp', expectedRevision: 'focus-1' },
  ]);
});

test('workspace exit outcome survives a closed dock and failure allows a single retry with diagnostics', async ({
  page,
  context,
}, testInfo) => {
  // Shared IPC fixture; this proves UI visibility, not native CS2 cleanup.
  let outcome = { busy: false, stage: '', message: null as string | null };
  let finishes = 0;
  let release!: () => void;
  const calls: { command: string; args?: unknown }[] = [];
  await context.exposeBinding('exitNative', async (_source, command: string, args?: unknown) => {
    if (command === 'workspace_exit_status') return outcome;
    if (command === 'cs2_config_status') return { pending: true, running: true, phase: 'running' };
    calls.push({ command, args });
    if (command === 'finish_workspace') {
      finishes++;
      outcome = { busy: true, stage: 'restoration', message: null };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      outcome =
        finishes === 1
          ? {
              busy: false,
              stage: 'restoration',
              message: 'CS2 尚未退出，请手动退出游戏后重试恢复。',
            }
          : { busy: false, stage: '', message: null };
      if (outcome.message) throw new Error(outcome.message);
    }
    return null;
  });
  await context.addInitScript(() =>
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) =>
          (
            window as unknown as {
              exitNative: (command: string, args?: unknown) => Promise<unknown>;
            }
          ).exitNative(command, args),
      },
    }),
  );
  await context.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: { connection: 'connected', findings: [], streaming: false, recording: false },
    }),
  );
  await context.route('**/operator/obs/*', (route) =>
    route.fulfill({ json: { alreadyRunning: true } }),
  );
  await context.route('**/local/v1/production', (route) =>
    route.fulfill({ json: { mode: 'live', revision: 'exit-1', canEnter: true } }),
  );
  await page.goto('/workspace/dock');
  await page.getByRole('button', { name: '退出工作台', exact: true }).click();
  await expect.poll(() => finishes).toBe(1);
  const recovery = await context.newPage();
  await recovery.goto('/');
  const result = recovery.getByLabel('工作台退出结果');
  await expect(result).toContainText('关闭游戏与恢复设置');
  await expect(
    recovery.getByRole('button', { name: '打开直播工作台', exact: true }),
  ).toBeDisabled();
  await expect(result.getByRole('button', { name: '正在退出…' })).toBeDisabled();
  await result.getByRole('button', { name: '运行诊断', exact: true }).click();
  expect(calls).toContainEqual({ command: 'open_tool', args: { tool: 'diagnostics' } });
  await page.close();
  release();
  await expect(result).toContainText('CS2 尚未退出，请手动退出游戏后重试恢复。');
  await expect(result.getByRole('button', { name: '重试退出工作台' })).toBeEnabled();
  await expect(
    recovery.getByText('CS2 尚未退出，请手动退出游戏后重试恢复。', { exact: true }),
  ).toHaveCount(1);
  const screenshot = testInfo.outputPath('workspace-exit-recovery.png');
  await recovery.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('隐藏后的退出失败反馈（浏览器 IPC 模拟）', {
    path: screenshot,
    contentType: 'image/png',
  });
  await result.getByRole('button', { name: '重试退出工作台' }).click();
  await expect.poll(() => finishes).toBe(2);
  await expect(result.getByRole('button', { name: '正在退出…' })).toBeDisabled();
  expect(finishes).toBe(2);
  release();
  await expect(result).toHaveCount(0);
});

test('exit recovery requires explicit Steam cancellation confirmation and permits changing that choice', async ({
  page,
  context,
}) => {
  let outcome = {
    busy: false,
    stage: 'restoration',
    message: 'Steam 启动仍在等待。请先取消 Steam 启动请求，并确认 CS2 已关闭，再恢复备份。' as
      string | null,
  };
  let finished = false;
  const requests: unknown[] = [];
  await context.exposeBinding('cancelExitNative', (_source, command: string, args?: unknown) => {
    if (command === 'workspace_exit_status') return outcome;
    if (command === 'cs2_config_status')
      return { pending: !finished, running: false, phase: finished ? 'idle' : 'uncertain' };
    if (command === 'finish_workspace') {
      requests.push(args);
      finished = true;
      outcome = { busy: false, stage: '', message: null };
    }
    return null;
  });
  await context.addInitScript(() =>
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) =>
          (
            window as unknown as {
              cancelExitNative: (command: string, args?: unknown) => Promise<unknown>;
            }
          ).cancelExitNative(command, args),
      },
    }),
  );
  await page.goto('/');
  const result = page.getByLabel('工作台退出结果');
  const retry = result.getByRole('button', { name: '恢复配置并重试退出' });
  const confirmation = result.getByRole('checkbox', {
    name: '已取消 Steam 启动请求，并确认 CS2 已关闭',
  });
  await expect(retry).toBeDisabled();
  await confirmation.check();
  await expect(retry).toBeEnabled();
  await confirmation.uncheck();
  await expect(retry).toBeDisabled();
  expect(requests).toHaveLength(0);
  await confirmation.check();
  await retry.click();
  expect(requests).toEqual([{ confirmSteamCancelled: true }]);
  await expect(result).toHaveCount(0);
});
