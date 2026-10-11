import { expect, test } from './companion-isolation.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';
import { readFileSync } from 'node:fs';
import type { WebSocketRoute } from '@playwright/test';
import { toMatchContext, type BroadcastManifest } from '../../packages/rivalhub/src/index.js';
import { adaptGsiPayload } from '../../packages/telemetry-gsi/src/adapter.js';
import { createProgramRuntime } from '../../apps/companion/src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../../apps/companion/src/projections/projection-coordinator.js';
import { createCstvSourceManagers } from '../../apps/companion/src/telemetry/cstv-source-manager.js';

test('match card exposes real map and Steam64 causes with task-specific recovery', async ({
  page,
}, testInfo) => {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        '../../packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as BroadcastManifest;
  const runtime = createProgramRuntime('workspace-cause-regression');
  let nowMonotonicMs = 0;
  const coordinator = createProjectionCoordinator({
    matchContextBinding: {
      manifest,
      context: toMatchContext(manifest),
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    nowMonotonicMs: () => nowMonotonicMs,
    predictionPublishCoalescing: false,
  });
  const players = [...manifest.entrants.a.roster.players, ...manifest.entrants.b.roster.players];
  const allplayers = Object.fromEntries(
    players.map((player, index) => {
      const steamid = index === 0 ? '76561198999999999' : player.steam64!;
      return [
        steamid,
        {
          steamid,
          name: player.displayName,
          team: index < 5 ? 'CT' : 'T',
          observer_slot: index,
          activity: 'playing',
          state: { health: 100 },
        },
      ];
    }),
  );
  try {
    await page.setViewportSize({ width: 320, height: 720 });
    const input = adaptGsiPayload(
      {
        map: {
          name: 'de_overpass',
          phase: 'live',
          round: 3,
          team_ct: { score: 2 },
          team_t: { score: 1 },
        },
        round: { phase: 'live' },
        allplayers,
      },
      { sequence: 1, receivedAt: '2026-10-11T00:00:00.000Z', receivedMonotonicMs: 0 },
    );
    if (!input.ok) throw new Error('Synthetic failure GSI rejected');
    coordinator.afterRuntimeMutation(runtime.acceptObservation(input.observation));
    const snapshot = coordinator.getPublisher('operator').getCurrent()!;
    expect(snapshot.payload.identity.issues.map((issue) => issue.code)).toContain('map_mismatch');
    expect(snapshot.payload.identity.issues.map((issue) => issue.code)).toContain(
      'unexpected_human_steam64',
    );
    let operatorSocket: WebSocketRoute | undefined;
    await page.routeWebSocket('**/local/v1/operator', (socket) => {
      operatorSocket = socket;
      socket.send(JSON.stringify(snapshot));
    });
    await page.addInitScript(() => {
      const host = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
        openedTasks: unknown[];
        failOpen: boolean;
      };
      host.openedTasks = [];
      host.failOpen = true;
      host.__TAURI_INTERNALS__ = {
        invoke: (command, args) => {
          if (host.failOpen) return Promise.reject(new Error('准备中心暂时无法打开，请重试。'));
          host.openedTasks.push({ command, args });
          return Promise.resolve(null);
        },
      };
    });
    await page.goto('/workspace/left');
    const card = page.getByRole('region', { name: '当前比赛与制作状态' });
    await expect(card).toContainText('地图不一致');
    await expect(card.getByRole('button', { name: '查看问题', exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: '核对地图', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('准备中心暂时无法打开');
    await page.evaluate(() => {
      (window as unknown as { failOpen: boolean }).failOpen = false;
    });
    await card.getByRole('button', { name: '核对地图', exact: true }).click();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { openedTasks: unknown[] }).openedTasks),
      )
      .toContainEqual({ command: 'open_main', args: { path: '/matches?tab=maps' } });
    await card.getByRole('button', { name: '全部问题' }).click();
    const dialog = page.getByRole('dialog', { name: '本场需要处理' });
    await expect(dialog).toContainText('选手 Steam64 不匹配');
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: '核对名单', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { openedTasks: unknown[] }).openedTasks),
      )
      .toContainEqual({ command: 'open_main', args: { path: '/matches?tab=roster' } });
    await page.screenshot({ path: testInfo.outputPath('workspace-actionable-causes.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(card.getByRole('button', { name: '全部问题' })).toBeFocused();
    await page.setViewportSize({ width: 256, height: 720 });
    expect(
      await card
        .getByRole('status')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.evaluate(() => {
      delete window.__TAURI_INTERNALS__;
      window.open = () => null;
    });
    await card.getByRole('button', { name: '核对地图', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('允许弹出窗口后重试');
    const recovered = adaptGsiPayload(
      {
        map: {
          name: 'de_ancient',
          phase: 'live',
          round: 3,
          team_ct: { score: 2 },
          team_t: { score: 1 },
        },
        round: { phase: 'live' },
        allplayers: Object.fromEntries(
          players
            .filter((player) => player.isStarter)
            .map((player, index) => [
              player.steam64!,
              {
                steamid: player.steam64,
                name: player.displayName,
                team: index < 5 ? 'CT' : 'T',
                observer_slot: index,
                activity: 'playing',
                state: { health: 100 },
              },
            ]),
        ),
      },
      { sequence: 2, receivedAt: '2026-10-11T00:00:01.000Z', receivedMonotonicMs: 1000 },
    );
    if (!recovered.ok) throw new Error('Recovery GSI rejected');
    nowMonotonicMs = 1000;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(recovered.observation));
    operatorSocket!.send(JSON.stringify(coordinator.getPublisher('operator').getCurrent()!));
    await expect(card).not.toContainText('地图不一致');
    await expect(card.getByRole('button', { name: '全部问题' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '核对名单' })).toHaveCount(0);
    await expect(card.getByRole('alert')).toHaveCount(0);
  } finally {
    await coordinator.close();
  }
});

test('Workspace preview shares the scene registry and sends a revisioned command', async ({
  page,
}) => {
  let command: unknown;
  await page.route('**/local/v1/program-scenes', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 'mizar.program-scenes.v1',
        active: 'waiting',
        revision: 'revision-1',
        available: PROGRAM_SCENES.map((scene) => scene.id),
        blocked: {},
      },
    }),
  );
  await page.route('**/operator/program-scene', async (route) => {
    command = route.request().postDataJSON() as unknown;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await expect(page.getByText('CS2 游戏画面')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).toBeVisible();
  await expect(page.getByRole('main', { name: '现场控制底栏' })).toBeVisible();
  for (const scene of PROGRAM_SCENES)
    await expect(page.getByRole('button', { name: scene.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect.poll(() => command).toEqual({ sceneId: 'matchup', expectedRevision: 'revision-1' });

  await page.goto('/settings?tab=obs');
  await expect(page.getByLabel('WebSocket 密码')).toBeVisible();
  await expect(page.getByRole('heading', { name: '连接控制', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并测试', exact: true })).toBeVisible();
});

test('every Program Scene route renders without match data', async ({ page }) => {
  for (const scene of PROGRAM_SCENES.filter((item) => item.id !== 'gameplay' && item.id !== 'bp')) {
    await page.goto(scene.path);
    await expect(page.locator(`.program-scene--${scene.id}`)).toBeVisible();
    if (scene.id === 'waiting')
      await expect(
        page.getByRole('heading', { name: 'BROADCAST STARTING SOON', exact: true }),
      ).toBeVisible();
    else await expect(page.locator(`.program-scene--${scene.id}`)).toBeEmpty();
  }
});

test('all scene controls stay visible and manual takeover can resume', async ({ page }) => {
  let mode = 'auto';
  let revision = 'auto-1';
  let warmupScene = 'waiting';
  let failScenes = false;
  const commands: unknown[] = [];
  await page.route('**/local/v1/program-scenes', (route) =>
    failScenes
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: {
            schemaVersion: 'mizar.program-scenes.v1',
            active: mode === 'manual' ? 'matchup' : 'waiting',
            revision,
            available: PROGRAM_SCENES.map((s) => s.id),
            blocked: {},
            director: {
              mode,
              warmupScene,
              next: 'gameplay',
              reason: null,
              introDurationMs: 3000,
              sceneElapsedMs: 0,
            },
          },
        }),
  );
  await page.route('**/operator/program-scene', async (route) => {
    commands.push(route.request().postDataJSON());
    mode = 'manual';
    revision = 'manual-2';
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/operator/program-director', async (route) => {
    const body = route.request().postDataJSON() as { action: string; scene: string };
    commands.push(body);
    if (body.action === 'warmup') {
      warmupScene = body.scene;
      revision = 'auto-choice';
    } else {
      mode = 'auto';
      revision = 'auto-3';
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await expect(page.getByText('自动编排', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '对阵', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'BP 控制', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'BP 工作台', exact: true })).toHaveCount(1);
  expect(commands).toEqual([]);
  await page.getByLabel('热身画面').selectOption('gameplay');
  await expect
    .poll(() => commands)
    .toEqual([{ action: 'warmup', scene: 'gameplay', expectedRevision: 'auto-1' }]);
  await expect(page.getByText('自动编排', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('热身画面')).toHaveValue('gameplay');
  failScenes = true;
  await expect(page.getByLabel('热身画面')).toBeDisabled();
  failScenes = false;
  await expect(page.getByLabel('热身画面')).toBeEnabled();
  await expect(page.getByLabel('热身画面')).toHaveValue('gameplay');
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect(page.getByText('手动保持', { exact: false })).toBeVisible();
  await page.getByLabel('热身画面').selectOption('waiting');
  await expect(page.getByLabel('热身画面')).toHaveValue('waiting');
  await expect(page.getByText('手动保持', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '恢复自动', exact: true }).click();
  await expect(page.getByRole('button', { name: '对阵', exact: true })).toBeVisible();
  expect(commands).toEqual([
    { action: 'warmup', scene: 'gameplay', expectedRevision: 'auto-1' },
    { sceneId: 'matchup', expectedRevision: 'auto-choice' },
    { action: 'warmup', scene: 'waiting', expectedRevision: 'manual-2' },
    { action: 'resume', expectedRevision: 'auto-choice' },
  ]);
});
