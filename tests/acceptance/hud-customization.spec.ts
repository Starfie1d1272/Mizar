import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { HudConfigStore } from '../../apps/companion/src/hud-config/store.js';
import { parseRealProgramArtifact } from '../../apps/web/src/program/fixtures/real-program-fixtures.js';
import { readHudPresetPack, type HudResolvedPreset } from '../../packages/hud-config/src/index.js';
import { expect, test } from './companion-isolation.js';

test('HUD settings preview → save → disk reload → activate → Program', async ({
  page,
  context,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-hud-customization-'));
  const filePath = join(directory, 'hud.json');
  let store = new HudConfigStore({ filePath });
  let app = buildApp({ hudConfigStore: store });
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
    const snapshot = artifact.fixtures['real-live-rich']!.snapshot;
    await context.routeWebSocket(/\/local\/v1\/program$/, (socket) =>
      socket.send(JSON.stringify(snapshot)),
    );
    await page.goto('/operator/hud?hud-config=companion');
    await page.getByRole('button', { name: '预设', exact: true }).click();
    await page
      .getByRole('combobox', { name: '配置组件', exact: true })
      .selectOption('focused-player');
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
    await app.close();
    store = new HudConfigStore({ filePath });
    await store.load();
    app = buildApp({ hudConfigStore: store });
    await app.ready();
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
    const reserveControl = page.getByRole('checkbox', { name: '显示备用弹药', exact: true });
    await reserveControl.focus();
    await expect(reserveControl).toBeFocused();
    await reserveControl.press('Space');
    await expect(page.locator('[data-ammo-presentation]')).toBeVisible();
    await reserveControl.press('Space');
    await expect(page.locator('[data-ammo-presentation]')).toHaveCount(0);
    await testInfo.attach('HUD customization preview', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
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
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('three broadcast presets save, activate and reload through the shared Program renderer', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-broadcast-presets-'));
  const filePath = join(directory, 'hud.json');
  let store = new HudConfigStore({ filePath });
  let app = buildApp({ hudConfigStore: store });
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
    const snapshot = artifact.fixtures['real-live-rich']!.snapshot;
    await context.routeWebSocket(/\/local\/v1\/program$/, (socket) =>
      socket.send(JSON.stringify(snapshot)),
    );
    const program = await context.newPage();
    for (const style of ['ewc', 'iem', 'perfectworld']) {
      await page.goto('/operator/hud?hud-config=companion');
      await page
        .locator('select:has(option[value="builtin:ewc-preset"])')
        .selectOption(`builtin:${style}-preset`);
      await expect(page.locator('[data-hud-widget="team-ct-rail"]')).toHaveAttribute(
        'data-hud-design',
        style,
      );
      const before = store.getState().etag;
      await page.getByLabel('名称', { exact: true }).fill(`${style} saved`);
      await page.getByRole('button', { name: '另存为', exact: true }).click();
      await expect(page.getByText(`已另存为「${style} saved」。`, { exact: true })).toBeVisible();
      expect(store.getState().etag).toBe(before);
      await page.getByRole('button', { name: '启用当前预设', exact: true }).click();
      await expect(page.getByText('当前预设已启用。', { exact: true })).toBeVisible();
      const frozen = store.getState().resolved;
      expect(frozen.theme.recipe).toBe(style);
      const previousApp = app;
      store = new HudConfigStore({ filePath });
      await store.load();
      const restartedApp = buildApp({ hudConfigStore: store });
      await restartedApp.ready();
      app = restartedApp;
      await previousApp.close();
      expect(store.getState().resolved).toEqual(frozen);
      await program.goto('/program?hud-config=companion');
      await expect(program.locator('[data-hud-widget="top-score-bar"]')).toHaveAttribute(
        'data-hud-design',
        style,
      );
      await expect(program.locator('[data-hud-widget="team-t-rail"]')).toHaveAttribute(
        'data-hud-design',
        style,
      );
      await expect(program.locator('.player-rail__avatar img').first()).toBeVisible();
    }
    await program.close();
  } finally {
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await rm(directory, { recursive: true, force: true });
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
    await page.goto('/operator/hud?hud-config=companion');
    await page
      .getByRole('combobox', { name: '预设', exact: true })
      .selectOption('builtin:perfectworld-preset');
    const right = page
      .locator(
        '[data-hud-widget="team-t-rail"] .player-rail__card:not(.player-rail__card--dead)[data-avatar="true"] .player-rail__body',
      )
      .first();
    const left = page
      .locator(
        '[data-hud-widget="team-ct-rail"] .player-rail__card:not(.player-rail__card--dead)[data-avatar="true"] .player-rail__body',
      )
      .first();
    await expect(left).toHaveCSS('border-radius', '0px 4px 4px 0px');
    await expect(right).toHaveCSS('border-radius', '4px 0px 0px 4px');
    await page
      .getByRole('combobox', { name: '示例比赛', exact: true })
      .selectOption('real-planted');
    await expect(page.locator('.player-rail__card--dead .player-rail__body').first()).toHaveCSS(
      'border-radius',
      '4px',
    );
    await page
      .getByRole('combobox', { name: '配置组件', exact: true })
      .selectOption('top-score-bar');
    await expect(page.getByRole('checkbox', { name: '显示存活对比', exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '显示系列赛胜图', exact: true })).toHaveCount(
      0,
    );
    const before = store.getState();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出预设文件', exact: true }).click();
    const download = await downloadEvent;
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
    await expect(page.locator('[data-hud-widget="top-score-bar"]')).toHaveCSS('width', '800px');
    await expect(page.locator('[data-hud-widget="focused-player"]')).toHaveCSS('height', '192px');
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
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('mixing Shanghai components with default layout uses one envelope for preview and layout editing', async ({
  page,
}) => {
  await page.goto('/operator/hud');
  await page.getByRole('combobox', { name: '配置组件', exact: true }).selectOption('top-score-bar');
  await page.getByLabel('呈现方案', { exact: true }).selectOption('perfectworld');
  await expect(page.locator('[data-hud-widget="top-score-bar"]')).toHaveCSS('width', '800px');
  await expect(page.locator('[data-hud-widget="top-score-bar"]')).toHaveCSS('height', '210px');
  await page
    .getByRole('combobox', { name: '配置组件', exact: true })
    .selectOption('focused-player');
  await page.getByLabel('呈现方案', { exact: true }).selectOption('perfectworld');
  await expect(page.locator('[data-hud-widget="focused-player"]')).toHaveCSS('width', '342px');
  await expect(page.locator('[data-hud-widget="focused-player"]')).toHaveCSS('height', '192px');
  await page.getByRole('button', { name: '布局', exact: true }).click();
  await page.getByRole('button', { name: '选择当前观察选手', exact: true }).click();
  const overlay = page.locator('.hud-editor-overlay__widget[data-hud-widget="focused-player"]');
  await expect(overlay).toHaveCSS('width', '342px');
  await expect(overlay).toHaveCSS('height', '192px');
});
