import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { HudConfigStore } from '../../apps/companion/src/hud-config/store.js';
import { parseRealProgramArtifact } from '../../apps/web/src/program/fixtures/real-program-fixtures.js';
import { readHudPresetPack, type HudResolvedPreset } from '../../packages/hud-config/src/index.js';
import { expect, test as baseTest } from './companion-isolation.js';

const test = baseTest.extend({
  context: async ({ context }, use) => {
    const errors: string[] = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await use(context);
    expect(errors, 'HUD authoring and Program pages have no uncaught browser errors').toEqual([]);
  },
});

test('HUD settings preview → save → disk reload → activate → Program', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-hud-customization-'));
  const filePath = join(directory, 'hud.json');
  let store = new HudConfigStore({ filePath });
  let app = buildApp({ hudConfigStore: store });
  let serviceReady = Promise.resolve();
  let resumeService: () => void = () => undefined;
  const inFlight = new Set<Promise<unknown>>();
  try {
    await app.ready();
    await context.route(/\/(?:operator|local\/v1)\/hud-config$/, async (route) => {
      await serviceReady;
      const request = route.request();
      const injection = app.inject({
        method: request.method() as 'GET' | 'POST',
        url: new URL(request.url()).pathname,
        headers: request.headers(),
        ...(request.postData() === null ? {} : { payload: request.postData()! }),
      });
      inFlight.add(injection);
      const response = await injection.finally(() => inFlight.delete(injection));
      await route.fulfill({
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: response.body,
      });
    });
    const artifact = parseRealProgramArtifact(
      JSON.parse(
        await readFile(
          new URL(
            '../../apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as unknown,
    );
    const snapshot = artifact.fixtures['real-live-rich']!.snapshot;
    await context.routeWebSocket(/\/local\/v1\/program$/, (socket) =>
      socket.send(JSON.stringify(snapshot)),
    );
    await page.goto('/operator/hud?hud-config=companion&mode=fixture');
    await page.getByRole('button', { name: '预设', exact: true }).click();
    await page
      .getByRole('combobox', { name: '配置组件', exact: true })
      .selectOption('focused-player');
    await expect(page.locator('.focused-player__metrics')).toHaveCount(0);
    await page.getByRole('checkbox', { name: '显示 K/A/D/ADR', exact: true }).check();
    await expect(page.locator('.focused-player__metrics')).toBeVisible();
    const originalEtag = store.getState().etag;
    await page.getByRole('checkbox', { name: '显示 K/A/D/ADR', exact: true }).uncheck();
    await expect(page.locator('.focused-player__metrics')).toHaveCount(0);
    await expect(page.locator('.focused-player__hp')).toBeVisible();
    await page.getByRole('combobox', { name: '配置组件', exact: true }).selectOption('radar');
    await page.getByLabel('雷达视野', { exact: true }).selectOption('auto');
    await page
      .getByRole('combobox', { name: '配置组件', exact: true })
      .selectOption('team-ct-rail');
    await page.getByRole('checkbox', { name: '显示经济', exact: true }).uncheck();
    await expect(page.locator('[data-hud-widget="team-ct-rail"] .player-rail__money')).toHaveCount(
      0,
    );
    await page.getByLabel('名称', { exact: true }).fill('内容定制验收');
    await page.getByRole('button', { name: '另存为', exact: true }).click();
    await expect(page.getByText('已另存为「内容定制验收」。', { exact: true })).toBeVisible();
    expect(store.getState().etag).toBe(originalEtag);
    serviceReady = new Promise<void>((resolve) => {
      resumeService = resolve;
    });
    await Promise.all(inFlight);
    await app.close();
    store = new HudConfigStore({ filePath });
    await store.load();
    app = buildApp({ hudConfigStore: store });
    await app.ready();
    resumeService();
    await page.reload();
    await page.getByRole('button', { name: '预设', exact: true }).click();
    await page
      .getByRole('combobox', { name: '预设', exact: true })
      .selectOption(store.getState().document.customPresets[0]!.id);
    await page
      .getByRole('combobox', { name: '配置组件', exact: true })
      .selectOption('focused-player');
    await expect(
      page.getByRole('checkbox', { name: '显示 K/A/D/ADR', exact: true }),
    ).not.toBeChecked();
    await page.getByLabel('呈现方案', { exact: true }).selectOption('minimal');
    await expect(page.locator('.focused-player__media img')).toHaveCount(0);
    await expect(page.locator('.focused-player__metrics')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('checkbox', { name: '显示 K/A/D/ADR', exact: true })).toHaveCount(
      0,
    );
    // The default EPL live sample observes a knife; use the recorded AWP state for ammo.
    await page
      .getByRole('combobox', { name: '示例比赛', exact: true })
      .selectOption('epl-defusing');
    const reserveControl = page.getByRole('checkbox', { name: '显示备用弹药', exact: true });
    await reserveControl.focus();
    await expect(reserveControl).toBeFocused();
    await reserveControl.press('Space');
    await expect(page.locator('[data-ammo-presentation]')).toBeVisible();
    await reserveControl.press('Space');
    await expect(page.locator('[data-ammo-presentation]')).toHaveCount(0);

    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '启用当前预设', exact: true }).click();
    await expect(page.getByText('当前预设已启用。', { exact: true })).toBeVisible();
    const resolved = store.getState().resolved;
    expect(resolved.widgets['focused-player'].variant).toBe('minimal');
    expect(resolved.widgets.radar.settings.zoomMode).toBe('auto');
    const program = await context.newPage();
    await program.goto('/program?hud-config=companion');
    await expect(program.locator('[data-gameplay-hud]')).toHaveAttribute(
      'data-hud-preset-id',
      resolved.preset.id,
    );
    await expect(program.locator('.focused-player__metrics')).toHaveCount(0);
    await expect(program.locator('.focused-player__hp')).toBeVisible();
    await expect(
      program.locator('[data-hud-widget="team-ct-rail"] .player-rail__money'),
    ).toHaveCount(0);
    expect(
      (await app.inject({ url: '/local/v1/hud-config' })).json<{ resolved: HudResolvedPreset }>()
        .resolved,
    ).toEqual(resolved);
    await program.close();
  } finally {
    resumeService?.();
    try {
      await context.unrouteAll({ behavior: 'wait' });
    } finally {
      try {
        await app.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test('preset files export, edit, import and activate without replacing resources or changing Program early', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-preset-files-'));
  const filePath = join(directory, 'hud.json');
  const store = new HudConfigStore({ filePath });
  const app = buildApp({ hudConfigStore: store });
  try {
    await app.ready();
    await context.route(/\/(?:operator|local\/v1)\/hud-config$/, async (route) => {
      const request = route.request();
      const response = await app.inject({
        method: request.method() as 'GET' | 'POST',
        url: new URL(request.url()).pathname,
        headers: request.headers(),
        ...(request.postData() === null ? {} : { payload: request.postData()! }),
      });
      await route.fulfill({
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: response.body,
      });
    });
    const artifact = parseRealProgramArtifact(
      JSON.parse(
        await readFile(
          new URL(
            '../../apps/web/src/program/fixtures/generated/real-program-fixtures.generated.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as unknown,
    );
    await context.routeWebSocket(/\/local\/v1\/program$/, (socket) =>
      socket.send(JSON.stringify(artifact.fixtures['real-live-rich']!.snapshot)),
    );
    await page.goto('/operator/hud?hud-config=companion&mode=fixture');
    await page
      .getByRole('combobox', { name: '预设', exact: true })
      .selectOption('builtin:perfectworld-preset');
    await page
      .getByRole('combobox', { name: '配置组件', exact: true })
      .selectOption('top-score-bar');
    await expect(page.getByRole('checkbox', { name: '显示存活对比', exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '显示系列赛胜图', exact: true })).toHaveCount(
      0,
    );
    const before = store.getState();
    await page.getByLabel('选择预设文件', { exact: true }).setInputFiles({
      name: 'invalid.mizar-hud.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{}'),
    });
    await expect(page.getByRole('alert').filter({ hasText: /配置|文件|预设/ })).toBeVisible();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出预设文件', exact: true }).click();
    const download = await downloadEvent;
    await expect(page.getByRole('status').filter({ hasText: '已导出预设文件' })).toBeVisible();
    expect(download.suggestedFilename()).toMatch(/\.mizar-hud\.json$/);
    const exportedPath = join(directory, 'export.mizar-hud.json');
    await download.saveAs(exportedPath);
    const pack = readHudPresetPack(await readFile(exportedPath, 'utf8'));
    pack.preset.name = '分享包往返';
    pack.preset.widgets.radar.settings.zoomMode = 'auto';
    pack.preset.widgets['team-ct-rail'].settings.showMoney = false;
    pack.layout.widgets['top-score-bar'].offsetY = 16;
    await page.getByLabel('选择预设文件', { exact: true }).setInputFiles({
      name: 'edited.mizar-hud.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(pack)),
    });
    await expect(
      page.getByText('已导入「分享包往返」。请在预设列表中选择并预览，启用后才会上屏。', {
        exact: true,
      }),
    ).toBeVisible();
    expect(store.getState().resolved).toEqual(before.resolved);
    const imported = store.getState().document.customPresets[0]!;
    expect(imported.id).not.toBe(pack.preset.id);
    expect(imported.layoutId).not.toBe(pack.layout.id);
    expect(imported.themeId).not.toBe(pack.theme.id);
    await page.getByRole('combobox', { name: '预设', exact: true }).selectOption(imported.id);
    await expect(page.locator('[data-hud-widget="team-ct-rail"] .player-rail__money')).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: '启用当前预设', exact: true }).click();
    await expect(page.getByText('当前预设已启用。', { exact: true })).toBeVisible();
    const program = await context.newPage();
    await program.goto('/program?hud-config=companion');
    await expect(program.locator('[data-gameplay-hud]')).toHaveAttribute(
      'data-hud-preset-id',
      imported.id,
    );
    await expect(
      program.locator('[data-hud-widget="team-ct-rail"] .player-rail__money'),
    ).toHaveCount(0);
    await expect(program.locator('[data-hud-widget="top-score-bar"]')).toHaveCSS('top', '16px');
    await program.close();
    const loaded = new HudConfigStore({ filePath });
    await loaded.load();
    expect(loaded.getState().resolved).toEqual(store.getState().resolved);
    const valid = store.getState().document;
    await page.getByLabel('选择预设文件', { exact: true }).setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ invalid'),
    });
    await expect(
      page.getByText('预设文件无效或版本不受支持，请检查 JSON、组件方案、外观与资源引用。', {
        exact: true,
      }),
    ).toBeVisible();
    expect(store.getState().document).toEqual(valid);
    await page.getByLabel('名称', { exact: true }).fill('未保存');
    await expect(page.getByRole('button', { name: '导入预设文件', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '导出预设文件', exact: true })).toBeDisabled();
  } finally {
    try {
      await context.unrouteAll({ behavior: 'wait' });
    } finally {
      try {
        await app.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test('HUD summaries distinguish loading, unavailable and last confirmed configurations', async ({
  page,
  context,
}) => {
  const app = buildApp({ hudConfigStore: new HudConfigStore({}) });
  await app.ready();
  let offline = false;
  let held = true;
  let resume: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await context.route(/\/local\/v1\/hud-config$/, async (route) => {
    if (held) await pending;
    if (offline) return route.fulfill({ status: 503, json: { error: 'fixture-offline' } });
    const result = await app.inject({ url: '/local/v1/hud-config' });
    return route.fulfill({
      status: result.statusCode,
      contentType: 'application/json',
      body: result.body,
    });
  });
  await context.route('**/operator/hud-config', async (route) => {
    const result = await app.inject({ url: '/operator/hud-config' });
    return route.fulfill({
      status: result.statusCode,
      contentType: 'application/json',
      body: result.body,
    });
  });
  try {
    await page.goto('/?tab=hud');
    await expect(
      page.getByRole('heading', { name: '正式播出 · 正在读取', exact: true }),
    ).toBeVisible();
    held = false;
    offline = true;
    resume!();
    await expect(
      page.getByRole('heading', { name: '正式播出 · 无法确认', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('尚无已确认的播出配置。', { exact: true })).toBeVisible();
    offline = false;
    await expect(page.getByRole('heading', { name: /正式播出 · Mizar/ })).toBeVisible();
    offline = true;
    await expect(
      page.getByRole('heading', { name: '正式播出 · 无法确认', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/最近确认：Mizar/)).toBeVisible();
    await page.goto('/operator/hud?hud-config=companion&mode=fixture');
    await expect(page.getByText('正式播出 · 无法确认', { exact: true })).toBeVisible();
    await expect(page.getByText('尚无已确认的播出配置', { exact: true })).toBeVisible();
    offline = false;
    await expect(page.getByText(/正式播出 · Mizar/)).toBeVisible();
    offline = true;
    await expect(page.getByText('正式播出 · 无法确认', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /最近确认：Mizar/ })).toBeVisible();
  } finally {
    resume!();
    try {
      await context.unrouteAll({ behavior: 'wait' });
    } finally {
      await app.close();
    }
  }
});

test('HUD resource directory targets the single editor by ID, preserves dirty drafts and explains activation', async ({
  page,
  context,
}) => {
  const app = buildApp();
  let available = true;
  try {
    await app.ready();
    await context.route(
      /\/(?:operator\/hud-config|local\/v1\/hud-config(?:\/editor)?)$/,
      async (route) => {
        if (!available) return route.fulfill({ status: 503 });
        const response = await app.inject({
          method: route.request().method() as 'GET' | 'POST',
          url: new URL(route.request().url()).pathname,
          headers: { origin: 'http://127.0.0.1:3000' },
          ...(route.request().method() === 'POST'
            ? { payload: route.request().postDataJSON() as Record<string, unknown> }
            : {}),
        });
        await route.fulfill({
          status: response.statusCode,
          body: response.body,
          contentType: 'application/json',
        });
      },
    );
    const opened: unknown[] = [];
    await page.exposeFunction('recordHudOpen', (value: unknown) => {
      opened.push(value);
    });
    await page.addInitScript(() => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: unknown) => {
            if (command === 'open_tool')
              await (
                window as unknown as { recordHudOpen: (value: unknown) => Promise<void> }
              ).recordHudOpen({ command, args });
            return false;
          },
        },
      });
    });
    await page.goto('/resources?tab=hud');
    const directory = page.getByRole('list', { name: 'HUD 预设目录' });
    await expect(directory).toContainText('内置只读');
    await expect(directory).toContainText('当前启用');
    await expect(directory).toContainText('布局');
    if (process.env.MIZAR_REVIEW_SCREENSHOTS)
      await page.screenshot({ path: `${process.env.MIZAR_REVIEW_SCREENSHOTS}/hud-directory.png` });
    await directory.getByRole('button', { name: /编辑.*EWC/ }).click();
    expect(opened).toContainEqual({
      command: 'open_tool',
      args: { tool: 'hud', presetId: 'builtin:ewc-preset' },
    });
    // Direct link also remains compatible with production Companion authoring mode.
    await page.goto('/operator/hud?hud-config=companion&mode=fixture&preset=builtin:ewc-preset');
    await expect(page.getByRole('combobox', { name: '预设', exact: true })).toHaveValue(
      'builtin:ewc-preset',
    );
    const originalOnAir = (await app.inject('/local/v1/hud-config')).body;
    await page.getByRole('button', { name: '布局', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('未保存布局草稿');
    await expect(page.getByRole('button', { name: '启用当前预设', exact: true })).toBeDisabled();
    await expect(page.getByLabel('启用条件与引用')).toContainText('布局有未保存更改');
    await expect(page.getByLabel('启用条件与引用')).toContainText('共享外观引用');
    await page.getByRole('button', { name: '定位需处理编辑区' }).click();
    await expect(page.getByRole('button', { name: '布局', exact: true })).toBeFocused();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('mizar:hud-select-preset', { detail: 'builtin:mizar-default-preset' }),
      ),
    );
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('未保存布局草稿');
    await expect(
      page.getByText('当前 HUD 布局有未保存草稿；切换预设会覆盖它，请先保存或放弃布局改动。', {
        exact: true,
      }),
    ).toBeVisible();
    available = false;
    await expect(page.getByLabel('启用条件与引用')).toContainText('配置连接未就绪');
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('未保存布局草稿');
    expect((await app.inject('/local/v1/hud-config')).body).toBe(originalOnAir);
    if (process.env.MIZAR_REVIEW_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.MIZAR_REVIEW_SCREENSHOTS}/hud-draft-connection-error.png`,
      });
    available = true;
    await page.getByRole('button', { name: '布局', exact: true }).click();
    // Avoid discarding a dirty draft through navigation; a new isolated page checks an invalid link.
    const missing = await context.newPage();
    await missing.goto('/operator/hud?hud-config=companion&mode=fixture&preset=missing-preset');
    await expect(
      missing.getByText('请求的 HUD 预设不存在；保留当前资源，未启用任何新预设。', { exact: true }),
    ).toBeVisible();
    expect((await app.inject('/local/v1/hud-config')).body).toBe(originalOnAir);
    await missing.close();
  } finally {
    try {
      await context.unrouteAll({ behavior: 'wait' });
    } finally {
      await app.close();
    }
  }
});
