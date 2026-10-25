import { expect, test } from './companion-isolation.js';
import { readFileSync, mkdirSync } from 'node:fs';
import { operatorSnapshotSchema } from '../../packages/protocol/src/operator.js';
import { programSnapshotSchema } from '../../packages/protocol/src/program.js';
import {
  programSceneStateSchema,
  type ProgramSceneState,
} from '../../packages/protocol/src/program-scenes.js';
import type { WebSocketRoute } from '@playwright/test';

test('preflight reviews current ten-player evidence, actual auto state, disconnects and invalidated completion', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2560, height: 1440 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = JSON.parse(
    readFileSync(
      'apps/web/src/program/fixtures/generated/epl-program-fixtures.generated.json',
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const program = programSnapshotSchema.parse(fixture.fixtures['epl-live']!.snapshot);
  program.payload.map.phase = 'warmup';
  const operator = operatorSnapshotSchema.parse(
    JSON.parse(readFileSync('tests/acceptance/fixtures/preflight-operator.json', 'utf8')),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sockets: { operator?: WebSocketRoute; program?: WebSocketRoute } = {};
  await page.routeWebSocket('**/local/v1/operator', (ws) => {
    sockets.operator = ws;
    ws.send(JSON.stringify(operator));
  });
  await page.routeWebSocket('**/local/v1/program', (ws) => {
    sockets.program = ws;
    ws.send(JSON.stringify(program));
  });
  const publish = () => {
    operatorSnapshotSchema.parse(operator);
    programSnapshotSchema.parse(program);
    operator.channelSeq++;
    program.channelSeq++;
    sockets.operator!.send(JSON.stringify(operator));
    sockets.program!.send(JSON.stringify(program));
  };
  let paired = true;
  let syncFailure = false;
  await page.route('**/local/v1/rivalhub-connection', (route) =>
    route.fulfill({
      json: {
        paired,
        sourceReady: paired,
        activeMatchId: program.payload.match!.matchId,
        activeSourceMatchId: paired ? program.payload.match!.matchId : null,
        syncHealth: {
          status: syncFailure ? 'attention' : 'inactive',
          reason: syncFailure ? 'network_failed' : null,
          incidentId: syncFailure ? 'simulated-network-incident' : null,
          deviceName: null,
        },
      },
    }),
  );
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: {
        connection: 'connected',
        streaming: true,
        recording: false,
        findings: [],
      },
    }),
  );
  const scenes: ProgramSceneState = programSceneStateSchema.parse({
    schemaVersion: 'mizar.program-scenes.v1',
    active: 'waiting',
    revision: 'preflight-review-1',
    available: ['waiting', 'gameplay'],
    blocked: {},
    director: {
      mode: 'manual',
      next: null,
      reason: null,
      warmupScene: 'waiting',
      introDurationMs: 0,
      sceneElapsedMs: 0,
    },
  });
  await page.route('**/local/v1/program-scenes', (route) => route.fulfill({ json: scenes }));
  const commands: Record<string, unknown>[] = [];
  await page.route('**/operator/program-director', async (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      expectedRevision: string;
      scene?: 'waiting' | 'gameplay';
    };
    commands.push(body);
    expect(body.expectedRevision).toBe(scenes.revision);
    if (body.action === 'resume') scenes.director!.mode = 'auto';
    if (body.action === 'warmup' && body.scene) scenes.director!.warmupScene = body.scene;
    await route.fulfill({ json: { ok: true } });
  });
  const screenshot = async (name: string) => {
    if (!process.env.MIZAR_PREFLIGHT_SCREENSHOTS) return;
    mkdirSync(process.env.MIZAR_PREFLIGHT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.MIZAR_PREFLIGHT_SCREENSHOTS}/${name}.png` });
    if (await dialog.isVisible())
      await dialog.screenshot({
        path: `${process.env.MIZAR_PREFLIGHT_SCREENSHOTS}/${name}-detail.png`,
      });
  };
  await page.goto('/workspace');
  const dialog = page.getByRole('dialog', { name: '赛前核对', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('已匹配 · 10 人');
  await screenshot('01-ten-players');
  const finish = dialog.getByRole('button', { name: '完成赛前核对' });
  await expect(finish).toBeDisabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '复制隐藏命令并返回游戏', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'cl_draw_only_deathnotices 1',
  );
  // Independent channels can deliver the same frame at different times. A
  // dismissed review must stay dismissed when alignment returns.
  const receiveSequence = operator.payload.runtime.lastAccepted!.receiveSequence;
  operator.payload.runtime.lastAccepted!.receiveSequence = receiveSequence + 1;
  publish();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(dialog).not.toBeVisible();
  operator.payload.runtime.lastAccepted!.receiveSequence = receiveSequence;
  publish();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '赛前核对', exact: true }).click();
  await expect(dialog).toBeVisible();
  if (await dialog.getByRole('button', { name: '恢复自动编排', exact: true }).isVisible()) {
    await dialog.getByRole('button', { name: '恢复自动编排', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '恢复自动编排', exact: true })).toHaveCount(0);
  }
  await dialog.getByLabel('热身时播出').selectOption('gameplay');
  await expect
    .poll(() => commands.some((c) => c.action === 'warmup' && c.scene === 'gameplay'))
    .toBe(true);
  await expect(dialog.getByLabel('热身时播出')).toHaveValue('gameplay');
  await expect(finish).toBeEnabled();
  await screenshot('09-ready-auto');
  await finish.click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '赛前核对已完成 · 查看' })).toBeVisible();
  await screenshot('02-completed');
  paired = false;
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('网站未连接');
  await expect(finish).toBeDisabled();
  await screenshot('03-website-disconnected');
  await dialog.getByRole('button', { name: '稍后处理' }).click();
  await expect(dialog).not.toBeVisible();
  paired = true;
  await expect(page.getByRole('button', { name: '赛前核对已完成 · 查看' })).toBeVisible({
    timeout: 10_000,
  });
  // A new roster issue invalidates the previous completion, with no website write.
  operator.payload.identity.state = 'degraded';
  operator.payload.identity.issues = [
    {
      code: 'lineup_differs_from_expected',
      message: '当前首发与网站名单不一致',
      severity: 'warning',
      sourcePlayerId: null,
      steam64: null,
      canonicalPlayerId: null,
      affectsExpectedLineup: true,
      entryId: null,
      observedSide: null,
      mapSide: null,
    },
  ];
  publish();
  await expect(dialog).toBeVisible();
  await expect(finish).toBeDisabled();
  await screenshot('04-roster-mismatch');
  operator.payload.identity.issues = [
    {
      ...operator.payload.identity.issues[0]!,
      code: 'map_mismatch',
      message: '地图与本场计划不一致',
    },
  ];
  publish();
  await expect(dialog).toContainText('地图不一致');
  await screenshot('05-map-mismatch');
  // Retained and stale telemetry must never pass the ready gate.
  operator.payload.activeLineup.retainedCount = 1;
  operator.payload.runtime.telemetryFreshness = 'stale';
  publish();
  await expect(
    dialog.getByText('等待新鲜、完整的双方五人观战数据；旧名单不会作为到齐依据。'),
  ).toBeVisible();
  await expect(finish).toBeDisabled();
  await screenshot('06-stale-data');
  await dialog.getByRole('button', { name: '本场比赛不再自动弹出' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '赛前核对', exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '赛前核对', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '恢复本场自动提醒' })).toBeVisible();
  await dialog.getByRole('button', { name: '稍后处理' }).click();
  operator.payload.activeLineup.retainedCount = 0;
  operator.payload.runtime.telemetryFreshness = 'fresh';
  publish();
  await expect(dialog).not.toBeVisible();
  const originalMatchId = operator.payload.matchContext.summary!.matchId;
  operator.payload.matchContext.summary!.matchId = 'next-preflight-match';
  program.payload.match!.matchId = 'next-preflight-match';
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '本场比赛不再自动弹出' })).toBeVisible();
  operator.payload.matchContext.summary!.matchId = originalMatchId;
  program.payload.match!.matchId = originalMatchId;

  operator.payload.identity.state = 'matched';
  operator.payload.identity.issues = [];
  operator.payload.activeLineup.retainedCount = 0;
  operator.payload.runtime.telemetryFreshness = 'fresh';
  program.payload.map.phase = 'live';
  syncFailure = true;
  await page.reload();
  const syncDialog = page.getByRole('dialog', { name: '本场网站同步需要处理' });
  await expect(syncDialog).toBeVisible();
  await expect(syncDialog).not.toContainText('.r');
  await screenshot('07-live-sync-failure');
  if (process.env.MIZAR_PREFLIGHT_SCREENSHOTS)
    await syncDialog.screenshot({
      path: `${process.env.MIZAR_PREFLIGHT_SCREENSHOTS}/07-live-sync-failure-detail.png`,
    });
  syncFailure = false;
  program.payload.map.phase = 'warmup';
  await page.addInitScript(() => {
    const host = window as typeof window & {
      reviewCommands: { command: string; args: unknown }[];
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    };
    host.reviewCommands = [];
    host.__TAURI_INTERNALS__ = {
      invoke: (command, args) => {
        host.reviewCommands.push({ command, args });
        return Promise.resolve(
          command === 'cs2_config_status'
            ? { preferMulnx: true, observerHudPending: true, pending: false, running: true }
            : command === 'restore_cs2_focus'
              ? true
              : null,
        );
      },
    };
    localStorage.clear();
  });
  await page.goto('/workspace/left');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & { reviewCommands: { command: string }[] }
          ).reviewCommands.filter((call) => call.command === 'open_tool').length,
      ),
    )
    .toBe(1);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.setViewportSize({ width: 1000, height: 1160 });
  await page.goto('/workspace/review?kind=preflight');
  await expect(dialog).toBeVisible();
  await screenshot('08-native-window-content');
  await dialog.getByRole('button', { name: '复制隐藏命令并返回游戏' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as typeof window & { reviewCommands: { command: string }[] }).reviewCommands.some(
          (call) => call.command === 'close_review',
        ),
      ),
    )
    .toBe(true);
  let hideGameHud = true;
  await page.route('**/local/v1/observer-assist', (route) =>
    route.fulfill({
      json: {
        settings: { enabled: false, expectedDelaySeconds: 120, leadSeconds: 7 },
        gameAutomation: { autoConnect: true, hideGameHud },
        connection: null,
      },
    }),
  );
  await expect(dialog).toContainText('本场使用自动隐藏游戏 HUD');
  await expect(dialog.getByRole('button', { name: '复制隐藏命令并返回游戏' })).toHaveCount(0);
  hideGameHud = false;
  await expect(dialog.getByRole('button', { name: '复制隐藏命令并返回游戏' })).toBeVisible();
  expect(errors).toEqual([]);
});
