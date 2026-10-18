import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { HudConfigStore } from '../../apps/companion/src/hud-config/store.js';
import { parseRealProgramArtifact } from '../../apps/web/src/program/fixtures/real-program-fixtures.js';
import { type HudResolvedPreset } from '../../packages/hud-config/src/index.js';
import { expect, test as baseTest } from './companion-isolation.js';

interface TaskRecord {
  stage: string;
  taskId?: string | null;
  trigger?: string;
  startupSessionId: string;
  evidence: {
    operation?: string;
    phase?: string;
    route?: string;
    evidence?: {
      kind?: string;
      taskId?: string;
      evidence?: { result?: string; activeRevision?: string };
    };
  };
}
async function taskRecords(directory: string): Promise<TaskRecord[]> {
  const text = await readFile(join(directory, 'logs/session.ndjson'), 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as TaskRecord];
    } catch {
      return [];
    }
  });
}
function taskKind(record: TaskRecord) {
  return record.stage === 'browser_control' && record.evidence.operation === 'task'
    ? record.evidence.evidence?.kind
    : undefined;
}

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
  let app = buildApp({ hudConfigStore: store, supportLogsDirectory: join(directory, 'logs') });
  let restarting = false;
  try {
    await app.ready();
    await context.route(
      /\/(?:operator|local\/v1)\/hud-config$|\/debug\/control-event$/,
      async (route) => {
        if (restarting) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'companion_offline' }),
          });
          return;
        }
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
      },
    );
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
    await expect
      .poll(
        async () =>
          (await taskRecords(directory)).filter(
            (record) => taskKind(record) === 'hud_save-as' && record.evidence.phase === 'terminal',
          ).length,
      )
      .toBe(1);
    // The editor keeps polling while the disk-backed Companion is restarted.
    restarting = true;
    await app.close();
    expect(await page.evaluate(async () => (await fetch('/operator/hud-config')).status)).toBe(503);
    store = new HudConfigStore({ filePath });
    await store.load();
    app = buildApp({ hudConfigStore: store, supportLogsDirectory: join(directory, 'logs') });
    await app.ready();
    restarting = false;
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
    await page.getByRole('button', { name: '应用', exact: true }).click();
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
    await expect
      .poll(
        async () =>
          (await taskRecords(directory)).filter(
            (record) =>
              taskKind(record) === 'hud_activate-preset' && record.evidence.phase === 'terminal',
          ).length,
      )
      .toBe(1);
    const exported = await app.inject({
      method: 'POST',
      url: '/debug/support-bundle',
      headers: { origin: 'http://127.0.0.1:4173' },
      payload: {},
    });
    expect(exported.statusCode).toBe(200);
    const bundlePath = join(directory, 'task-bundle.json');
    await writeFile(bundlePath, exported.body);
    const timeline = execFileSync(
      process.execPath,
      ['scripts/diagnostics/read-support-bundle.mjs', bundlePath],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TaskRecord);
    const starts = timeline.filter(
      (record) => record.evidence?.phase === 'begin' && taskKind(record),
    );
    for (const kind of ['hud_save-as', 'hud_save-resource', 'hud_activate-preset']) {
      const start = starts.find((record) => taskKind(record) === kind);
      expect(start, `${kind} root preserved in the real exported archive`).toBeDefined();
      const id = start!.evidence.evidence!.taskId;
      expect(start!.taskId).toBe(id);
      const result = timeline.find(
        (record) => record.taskId === id && record.evidence.phase === 'terminal',
      );
      expect(result?.evidence.evidence?.evidence?.result).toBe('confirmed');
      expect(
        timeline.some(
          (record) =>
            record.stage === 'operation_result' &&
            record.taskId === id &&
            record.evidence.route === '/operator/hud-config',
        ),
      ).toBe(true);
    }
    expect(new Set(starts.map((record) => record.startupSessionId)).size).toBe(2);
    const activation = timeline.find(
      (record) =>
        taskKind(record) === 'hud_activate-preset' && record.evidence.phase === 'terminal',
    );
    expect(activation?.evidence.evidence?.evidence?.activeRevision).toBe(
      store.getState().activeRevision,
    );
  } finally {
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('picture selection previews without activation, then applies explicitly and opens the selected editor', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-picture-selection-'));
  const app = buildApp({
    hudConfigStore: new HudConfigStore({ filePath: join(directory, 'hud.json') }),
  });
  let mutations = 0;
  let offline = false;
  await context.route(
    /\/(?:operator|local\/v1)\/hud-config$|\/debug\/control-event$/,
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (offline && pathname.endsWith('/hud-config'))
        return route.fulfill({ status: 503, json: { error: 'offline' } });
      if (pathname === '/operator/hud-config' && request.method() === 'POST') mutations++;
      const response = await app.inject({
        method: request.method() as 'GET' | 'POST',
        url: pathname,
        headers: request.headers(),
        ...(request.postData() ? { payload: request.postData()! } : {}),
      });
      await route.fulfill({
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: response.body,
      });
    },
  );
  const capture = async (name: string) => {
    if (!process.env.MIZAR_CAPTURE_HUD) return;
    await import('node:fs/promises').then((fs) =>
      fs.mkdir('docs/screenshots/hud-workflow', { recursive: true }),
    );
    await page.screenshot({ path: `docs/screenshots/hud-workflow/${name}.png`, fullPage: false });
  };
  try {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.goto('/picture');
    await expect(page.getByRole('button', { name: '已应用', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '类 EWC', exact: true })).toBeEnabled();
    await expect(page.locator('.picture-preview .hud-console__canvas-logical')).toBeVisible();
    await capture('01-open');
    const initial = (await app.inject({ url: '/local/v1/hud-config' })).json<unknown>();
    await page.getByRole('button', { name: '类 EWC', exact: true }).click();
    await expect(page.getByRole('button', { name: '应用', exact: true })).toBeEnabled();
    await expect(page.locator('.picture-active')).toContainText('Mizar 默认预设');
    await expect(page.locator('.picture-preview-caption')).toContainText('类 EWC');
    expect((await app.inject({ url: '/local/v1/hud-config' })).json()).toEqual(initial);
    expect(mutations).toBe(0);
    await capture('02-select-preview');
    await page.getByRole('button', { name: '对阵', exact: true }).click();
    await expect(page.frameLocator('iframe[title="节目场景预览"]').locator('body')).toContainText(
      'VS',
    );
    expect(mutations).toBe(0);
    await expect(
      page.frameLocator('iframe[title="节目场景预览"]').locator('.intro-body'),
    ).toHaveCSS('opacity', '1');
    await capture('03-matchup-same-area');
    await page.getByRole('button', { name: 'BP', exact: true }).click();
    await expect(page.getByText('本场暂无完整 BP。现场将按已有比赛资料继续编排。')).toBeVisible();
    await capture('04-no-bp');
    await page.getByRole('button', { name: '比赛中', exact: true }).click();
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.getByText('已应用「类 EWC」。', { exact: true })).toBeVisible();
    expect(mutations).toBe(1);
    expect(
      (await app.inject({ url: '/local/v1/hud-config' })).json<{ resolved: HudResolvedPreset }>()
        .resolved.preset.name,
    ).toBe('类 EWC');
    await capture('05-applied');
    for (const [width, height] of [
      [1920, 1080],
      [3840, 2160],
      [2560, 1440],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect
        .poll(async () => {
          const box = await page.locator('.picture-preview').boundingBox();
          return box ? box.y + box.height : Infinity;
        })
        .toBeLessThanOrEqual(height);
      const box = await page.locator('.picture-preview').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
      await expect(page.locator('.picture-preview-caption')).toBeInViewport();
      await expect(page.getByRole('button', { name: '调整此预设', exact: true })).toBeInViewport();
    }
    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: '调整此预设', exact: true }).click();
    const editor = await popup;
    await editor.setViewportSize({ width: 2560, height: 1440 });
    await expect(editor.getByText('正在编辑 · 类 EWC', { exact: true })).toBeVisible();
    // The acceptance host defaults to visual fixtures; opt this popup into the isolated Companion.
    await editor.goto(`${editor.url()}&hud-config=companion`);
    await expect(editor.getByText('已应用', { exact: true }).first()).toBeVisible();
    await editor.getByRole('combobox', { name: '预览来源', exact: true }).selectOption('fixture');
    await editor.getByRole('button', { name: '布局', exact: true }).click();
    await expect(
      editor.locator('.hud-console__canvas-logical .match-header').first(),
    ).toBeVisible();
    if (process.env.MIZAR_CAPTURE_HUD)
      await editor.screenshot({
        path: 'docs/screenshots/hud-workflow/06-adjust-editor.png',
        fullPage: false,
      });
    await editor.close();
    offline = true;
    await expect(page.getByText('连接未就绪，暂不能应用。')).toBeVisible();
    await expect(page.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
    await capture('07-disconnected');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
