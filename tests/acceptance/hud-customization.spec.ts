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
