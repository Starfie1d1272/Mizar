import type { MatchDocumentV1 } from '../../packages/core/src/match-context/index.js';
import type { SeriesBindingView } from '../../packages/protocol/src/operator.js';
import { expect, test } from './companion-isolation.js';
import { PROGRAM_SCENES } from '../../packages/protocol/src/program-scenes.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { LocalTournamentStore } from '../../apps/companion/src/match-context/local-tournament-store.js';
import {
  RivalHubConnection,
  OFFICIAL_RIVALHUB_URL,
} from '../../apps/companion/src/match-context/rivalhub-connection.js';
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
    await dialog.getByRole('button', { name: '核对网站名单', exact: true }).click();
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
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

async function connectOwnedCompanion(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
  app: ReturnType<typeof buildApp>,
) {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  await context.route(
    (url) => url.pathname.startsWith('/local/v1/') || url.pathname.startsWith('/operator/'),
    async (route) => {
      const request = route.request();
      const response = await app.inject({
        method: request.method() as 'GET' | 'POST',
        url: new URL(request.url()).pathname,
        headers: request.headers(),
        ...(request.postData() === null ? {} : { payload: request.postData()! }),
      });
      await route.fulfill({
        status: response.statusCode,
        body: response.body,
        contentType: String(response.headers['content-type'] ?? 'application/json'),
      });
    },
  );
  // Route only the test-owned endpoint: messages still traverse the real local
  // websocket transport, protocol, SDK and UI; no fabricated snapshots.
  await page.addInitScript((address) => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const target = new URL(url, window.location.href);
        if (target.pathname.startsWith('/local/v1/')) target.host = new URL(address).host;
        super(target, protocols);
      }
    };
  }, address);
  await page.routeWebSocket(`ws://${new URL(address).host}/local/v1/**`, (socket) => {
    socket.connectToServer();
  });
}

function liveRoster(
  players: { steam64: string; displayName?: string | null }[],
  mapName = 'de_ancient',
  mapPhase = 'live',
) {
  return {
    auth: { token: 'recovery-test' },
    map: {
      name: mapName,
      phase: mapPhase,
      round: 3,
      team_ct: { name: 'Alpha', score: 2 },
      team_t: { name: 'Beta', score: 1 },
    },
    round: { phase: 'live' },
    allplayers: Object.fromEntries(
      players.map((player, index) => [
        player.steam64,
        {
          steamid: player.steam64,
          name: player.displayName ?? `Observed ${index}`,
          team: index < 5 ? 'CT' : 'T',
          observer_slot: index,
          activity: 'playing',
          state: { health: 100 },
        },
      ]),
    ),
  };
}

function ownedRuntime() {
  const runtime = createProgramRuntime('workspace-recovery-closure', {
    liveSession: { kind: 'bound', liveSessionId: 'recovery-closure-session' },
  });
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    nowMonotonicMs: () => 0,
    predictionPublishCoalescing: false,
  });
  return { runtime, coordinator };
}

function sampleManifest(): BroadcastManifest {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as BroadcastManifest;
}

const stableClock = {
  now: () => ({ receivedAt: '2026-10-11T00:00:00.000Z', receivedMonotonicMs: 0 }),
};

test('local server confirmation repairs the live lineup without deleting an unlinked substitute or guessing by name', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-roster-closure-'));
  const { runtime, coordinator } = ownedRuntime();
  const players = Array.from({ length: 10 }, (_, index) => ({
    steam64: String(76561198000000001n + BigInt(index)),
    displayName: `Observed ${index}`,
  }));
  const canonical = players.map((player, index) => ({
    ...player,
    playerId: `player-${index}`,
    avatarUrl: null,
    isStarter: true,
  }));
  const legacy = {
    playerId: 'unlinked',
    steam64: null,
    displayName: players[0]!.displayName,
    avatarUrl: null,
    isStarter: true,
  };
  const path = join(directory, 'tournament.json');
  const store = new LocalTournamentStore(path);
  const seed = await store.createMatch({
    teamA: 'Alpha',
    teamB: 'Beta',
    format: 'bo3',
    mapPool: ['de_ancient'],
    playersA: [legacy, ...canonical.slice(1, 5)],
    playersB: canonical.slice(5),
  });
  const app = buildApp({
    localTournamentPath: path,
    matchManifestPath: join(directory, 'manifest.json'),
    gsiToken: 'recovery-test',
    programRuntime: runtime,
    projectionCoordinator: coordinator,
    clock: stableClock,
  });
  try {
    await connectOwnedCompanion(page, context, app);
    await page.goto('/workspace/left');
    await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).not.toContainText(
      '选手 Steam64 缺失',
    );
    expect(
      (await app.inject({ method: 'POST', url: '/gsi', payload: liveRoster(players) })).statusCode,
    ).toBe(204);
    const card = page.getByRole('region', { name: '当前比赛与制作状态' });
    await expect(card).toContainText('选手 Steam64 缺失');
    await card.getByRole('button', { name: '选手 Steam64 缺失', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '本场需要处理' })).toContainText(
      '从当前服务器识别首发',
    );
    await page.keyboard.press('Escape');
    const popupPromise = page.waitForEvent('popup');
    await card.getByRole('button', { name: '识别服务器首发', exact: true }).click();
    const recovery = await popupPromise;
    await expect(recovery).toHaveURL(/matches\?tab=roster/);
    await recovery.close();
    await page.goto('/matches?tab=roster');
    await page.getByRole('button', { name: '从当前服务器识别首发', exact: true }).click();
    await page.getByRole('button', { name: '确认保存首发', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '名单已保存。' })).toBeVisible();
    const document = (await app.inject('/local/v1/match-document')).json<{
      document: MatchDocumentV1;
    }>().document;
    expect(document.matchId).toBe(seed.matchId);
    expect(
      document.entrants.a.players.find((p: { playerId: string }) => p.playerId === 'unlinked'),
    ).toEqual({ ...legacy, isStarter: false });
    const observedPlayer = document.entrants.a.players.find(
      (p) => p.steam64 === players[0]!.steam64,
    );
    expect(observedPlayer).toBeDefined();
    expect(observedPlayer!.playerId).not.toBe('unlinked');
    const current = coordinator.getCurrent().operator;
    expect(current.identity.state).toBe('matched');
    expect(
      current.identity.issues.some((issue) => issue.code === 'missing_canonical_steam64'),
    ).toBe(true);
    await page.goto('/workspace/left');
    await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).not.toContainText(
      '选手 Steam64 缺失',
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a website-owned local BP overlay keeps its roster read-only and recovers a network failure by the card retry', async ({
  page,
  context,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-online-closure-'));
  const { runtime, coordinator } = ownedRuntime();
  const base = sampleManifest();
  const manifest: BroadcastManifest = {
    ...base,
    entrants: {
      ...base.entrants,
      a: {
        ...base.entrants.a,
        roster: {
          ...base.entrants.a.roster,
          players: base.entrants.a.roster.players.map((player) =>
            player.isStarter ? player : { ...player, steam64: null },
          ),
        },
      },
    },
  };
  coordinator.setMatchContextBinding({
    manifest,
    context: toMatchContext(manifest),
    origin: 'online',
    freshness: 'fresh',
    diagnostics: [],
  });
  let failing = true;
  const connectionPath = join(directory, 'connection.json');
  await writeFile(
    connectionPath,
    JSON.stringify({
      baseUrl: OFFICIAL_RIVALHUB_URL,
      credential: 'private-recovery-token',
      installationId: 'recovery',
      competitionId: manifest.match.competition!.competitionId,
      displayName: 'Test',
    }),
  );
  coordinator.setMatchContextBinding({
    manifest,
    context: toMatchContext(manifest),
    origin: 'local',
    localAuthoringMode: 'bound-overlay',
    freshness: 'fresh',
    diagnostics: [],
  });
  const connection = new RivalHubConnection(connectionPath, () => {
    if (failing) return Promise.reject(new TypeError('private-recovery-token /personal/path'));
    return Promise.resolve(Response.json(manifest));
  });
  await connection.load();
  const app = buildApp({
    matchManifestPath: join(directory, 'manifest.json'),
    matchContextBinding: {
      manifest,
      context: toMatchContext(manifest),
      origin: 'local',
      localAuthoringMode: 'bound-overlay',
      freshness: 'fresh',
      diagnostics: [],
    },
    rivalhubConnection: connection,
    gsiToken: 'recovery-test',
    programRuntime: runtime,
    projectionCoordinator: coordinator,
    clock: stableClock,
  });
  try {
    await connectOwnedCompanion(page, context, app);
    const players = [
      ...manifest.entrants.a.roster.players.filter((p) => p.isStarter),
      ...manifest.entrants.b.roster.players.filter((p) => p.isStarter),
    ];
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: liveRoster(
            players.map((p) => ({ steam64: p.steam64!, displayName: p.displayName })),
            manifest.maps[1]!.mapName,
          ),
        })
      ).statusCode,
    ).toBe(204);
    await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: liveRoster(
        players.map((p) => ({ steam64: p.steam64!, displayName: p.displayName })),
        'de_overpass',
      ),
    });
    await page.goto('/workspace/left');
    const wrongMapCard = page.getByRole('region', { name: '当前比赛与制作状态' });
    await expect(wrongMapCard).toContainText('地图不一致');
    await expect(wrongMapCard).not.toContainText('选手 Steam64 缺失');
    await expect(
      wrongMapCard.getByRole('button', { name: '核对网站名单', exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('website-bench-wrong-map.png') });
    await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: liveRoster(
        players.map((p) => ({ steam64: p.steam64!, displayName: p.displayName })),
        manifest.maps[1]!.mapName,
      ),
    });
    await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: liveRoster(
        players.map((p) => ({ steam64: p.steam64!, displayName: p.displayName })),
        manifest.maps[1]!.mapName,
      ),
    });
    await page.goto('/matches?tab=roster');
    await expect(page.getByRole('button', { name: '确认保存首发' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '打开网站本场工作台' })).toBeVisible();
    await page.getByRole('button', { name: '刷新比赛资料与 BP', exact: true }).click();
    await expect
      .poll(() => coordinator.getCurrent().operator.matchContext.sourceFailure)
      .toBe('network');
    expect(coordinator.getCurrent().operator.matchContext.rosterAuthority).toBe('rivalhub');
    await page.goto('/workspace/left');
    const card = page.getByRole('region', { name: '当前比赛与制作状态' });
    await expect(card).toContainText('网站比赛资料更新失败');
    await expect(card).not.toContainText('private-recovery-token');
    failing = false;
    await card.getByRole('button', { name: '重试更新资料', exact: true }).click();
    await expect(card).not.toContainText('网站比赛资料更新失败');
    expect(coordinator.getCurrent().operator.matchContext.sourceFailure).toBeNull();
    expect(coordinator.getCurrent().operator.matchContext.freshness).toBe('fresh');
    expect(coordinator.getCurrent().operator.identity.state).toBe('matched');
    expect(
      (await app.inject('/local/v1/match-document')).json<{ document: MatchDocumentV1 }>().document
        .entrants.a.players,
    ).toEqual(toMatchContext(manifest).entrants.a.players);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('manual current-map confirmation reaches the real owner, rejects an expired review and preserves earlier facts', async ({
  page,
  context,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-map-closure-'));
  const { runtime, coordinator } = ownedRuntime();
  const manifest = sampleManifest();
  coordinator.setMatchContextBinding({
    manifest,
    context: toMatchContext(manifest),
    origin: 'online',
    freshness: 'fresh',
    diagnostics: [],
  });
  const app = buildApp({
    matchManifestPath: join(directory, 'manifest.json'),
    matchContextBinding: {
      manifest,
      context: toMatchContext(manifest),
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
    gsiToken: 'recovery-test',
    programRuntime: runtime,
    projectionCoordinator: coordinator,
    clock: stableClock,
  });
  const players = [
    ...manifest.entrants.a.roster.players.filter((p) => p.isStarter),
    ...manifest.entrants.b.roster.players.filter((p) => p.isStarter),
  ].map((p) => ({ steam64: p.steam64!, displayName: p.displayName }));
  try {
    await connectOwnedCompanion(page, context, app);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: liveRoster(players, 'Nuke', 'warmup'),
        })
      ).statusCode,
    ).toBe(204);
    await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: liveRoster(players, 'Nuke', 'warmup'),
    });
    expect(coordinator.getCurrent().operator.identity.state).toBe('matched');
    const before = structuredClone(coordinator.getCurrent().operator.seriesProgress!);
    const reviewed = (await app.inject('/local/v1/series-binding')).json<{
      binding: SeriesBindingView;
    }>().binding;
    expect(before.bindingState).toBe('needs_operator');
    expect(reviewed.canBind).toBe(true);
    await page.goto('/workspace/left');
    await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).toContainText(
      '当前图尚未确认为第 3 图',
    );
    await page.goto('/matches?tab=maps');
    const panel = page.getByRole('region', { name: '确认当前地图所属场次' });
    await expect(panel.getByRole('button', { name: '确认当前是第 3 图' })).toBeEnabled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: liveRoster(players, manifest.maps[0]!.mapName),
        })
      ).statusCode,
    ).toBe(204);
    await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: liveRoster(players, manifest.maps[2]!.mapName),
    });
    await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: liveRoster(players, manifest.maps[2]!.mapName),
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/operator/series/bind',
      headers: { origin: 'http://127.0.0.1' },
      payload: {
        kind: 'bind-current-map-execution-to-series-map',
        mapOrder: 3,
        reason: 'expired review',
        expectedRevision: reviewed.revision,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(coordinator.getCurrent().operator.seriesProgress!.score).toEqual(before.score);
    await expect(panel).toContainText('比赛或地图已变化');
    await expect(panel.getByRole('button', { name: '确认当前是第 3 图' })).toBeDisabled();
    await panel.getByRole('button', { name: '重新核对当前图' }).click();
    await panel.getByRole('button', { name: '确认当前是第 3 图' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已确认当前是第 3 图' })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('map-confirmation-recovered.png'),
      fullPage: true,
    });
    const after = coordinator.getCurrent().operator.seriesProgress!;
    expect(after.bindingState).toBe('bound');
    expect(after.currentMapOrder).toBe(3);
    expect(after.score).toEqual(before.score);
    expect(after.maps[0]).toEqual(before.maps[0]);
    expect(
      (await app.inject('/local/v1/match-document')).json<{ document: MatchDocumentV1 }>().document
        .maps,
    ).toEqual(toMatchContext(manifest).maps);
    await page.goto('/workspace/left');
    await expect(page.getByRole('region', { name: '当前比赛与制作状态' })).not.toContainText(
      '当前图尚未确认',
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
