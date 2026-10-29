import type { LiveSnapshotV1, ReliableEventV1 } from '../../packages/protocol/src/output.js';
import type { MatchDocumentV1 as WireMatchDocument } from '../../packages/protocol/src/context.js';
import type { MatchDocumentV1 } from '../../packages/core/src/match-context/index.js';
import type { SeriesBindingView } from '../../packages/protocol/src/operator.js';
import { expect, test } from './companion-isolation.js';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RivalHubConnection,
  OFFICIAL_RIVALHUB_URL,
} from '../../apps/companion/src/match-context/rivalhub-connection.js';
import { buildApp } from '../../apps/companion/src/app.js';
import {
  toMatchContext,
  toMatchDocumentV1,
  type BroadcastManifest,
} from '../../packages/rivalhub/src/index.js';
import { mapOperatorProjection } from '../../apps/companion/src/local-protocol/operator-wire.js';
import { mapProgramProjection } from '../../apps/companion/src/local-protocol/program-wire.js';
import { workspaceLiveRosterAlert } from '../../apps/web/src/workspace/live-roster-model.js';
import { createProgramRuntime } from '../../apps/companion/src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../../apps/companion/src/projections/projection-coordinator.js';
import { createCstvSourceManagers } from '../../apps/companion/src/telemetry/cstv-source-manager.js';

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
  return address;
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
    const revision = (await app.inject('/local/v1/production')).json<{ revision: string }>()
      .revision;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/production',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { action: 'enter', expectedRevision: revision },
        })
      ).statusCode,
    ).toBe(200);
    await page.goto('/matches?tab=details');
    await page.getByText('现场地图对应（异常时处理）', { exact: true }).click();
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
    // Stop UI polling and drain its route callbacks before closing the owned server.
    await page.close();
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('online account differences alert once, preserve unknown identities and reach the website roster workflow', async ({
  page,
  context,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-roster-alert-'));
  const { runtime, coordinator } = ownedRuntime();
  const sourceManifest = sampleManifest();
  const manifest = {
    ...sourceManifest,
    maps: sourceManifest.maps.map((map) => ({
      ...map,
      scoreA: null,
      scoreB: null,
      completedAt: null,
    })),
  };
  const connectionPath = join(directory, 'connection.json');
  await writeFile(
    connectionPath,
    JSON.stringify({
      baseUrl: OFFICIAL_RIVALHUB_URL,
      credential: 'test-only',
      installationId: 'test-only',
      competitionId: manifest.match.competition!.competitionId,
      displayName: '测试制播机',
    }),
  );
  const outgoing: { operation: string; body: unknown }[] = [];
  let rejectMapStarts = false;
  let liveAccepted = true;
  let healthOffset = 0;
  let otherDevice = false;
  const connection = new RivalHubConnection(
    connectionPath,
    (url, init) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const operation = requestUrl.split('/').at(-1)!;
      if (typeof init?.body === 'string')
        outgoing.push({ operation, body: JSON.parse(init.body) as unknown });
      if (operation === 'claim')
        return Promise.resolve(
          Response.json({
            claimed: !otherDevice,
            authorityRevision: 1,
            activeDeviceName: otherDevice ? '备用制播机' : undefined,
          }),
        );
      if (operation === 'live') return Promise.resolve(Response.json({ accepted: liveAccepted }));
      if (operation === 'reliable')
        return Promise.resolve(new Response(null, { status: rejectMapStarts ? 409 : 204 }));
      return Promise.resolve(Response.json(manifest));
    },
    OFFICIAL_RIVALHUB_URL,
    () => performance.now() + healthOffset,
  );
  await connection.load();
  const binding = {
    manifest,
    context: toMatchContext(manifest),
    origin: 'online' as const,
    freshness: 'fresh' as const,
    diagnostics: [],
  };
  coordinator.setMatchContextBinding(binding);
  const app = buildApp({
    matchManifestPath: join(directory, 'manifest.json'),
    matchContextBinding: binding,
    rivalhubConnection: connection,
    reliableOutboxPath: join(directory, 'outbox.json'),
    gsiToken: 'recovery-test',
    programRuntime: runtime,
    projectionCoordinator: coordinator,
    clock: { now: () => ({ receivedAt: new Date().toISOString(), receivedMonotonicMs: 0 }) },
  });
  const starters = [
    ...manifest.entrants.a.roster.players.filter((p) => p.isStarter),
    ...manifest.entrants.b.roster.players.filter((p) => p.isStarter),
  ].map((p) => ({ steam64: p.steam64!, displayName: p.displayName }));
  const changed = starters.map((p, i) =>
    i === 4 || i === 9
      ? {
          steam64: i === 4 ? '76561198099999991' : '76561198099999992',
          displayName: i === 4 ? '广州老头乐' : '卡油兔克',
        }
      : p,
  );
  try {
    const address = await connectOwnedCompanion(page, context, app);
    const revision = (await app.inject('/local/v1/production')).json<{ revision: string }>()
      .revision;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/production',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { action: 'enter', expectedRevision: revision },
        })
      ).statusCode,
    ).toBe(200);
    const push = async (players: typeof starters, warmup = false) => {
      const frame = liveRoster(players, manifest.maps[0]!.mapName, warmup ? 'warmup' : 'live');
      if (warmup) {
        frame.map.round = 0;
        frame.map.team_ct.score = 0;
        frame.map.team_t.score = 0;
      }
      const response = await fetch(`${address}/gsi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(frame),
      });
      expect(response.status).toBe(204);
    };
    await push(changed);
    await push(changed);
    const bundle = coordinator.getCurrent();
    expect(bundle.identity.state).toBe('degraded');
    expect(
      bundle.program.players.filter((p) => p.sourcePlayerId.startsWith('7656119809999999')),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalPlayerId: null, displayName: '广州老头乐' }),
        expect.objectContaining({ canonicalPlayerId: null, displayName: '卡油兔克' }),
      ]),
    );
    const document = (await app.inject('/local/v1/match-document')).json<{
      document: WireMatchDocument;
    }>().document;
    const operator = mapOperatorProjection(bundle.operator);
    const program = mapProgramProjection(bundle.program);
    const acceptedConnection = {
      paired: true,
      activeMatchId: manifest.match.matchId,
      activeSourceMatchId: manifest.match.matchId,
      sourceReady: true,
      liveDelivery: { status: 'accepted' as const, cursor: bundle.program.cursor },
    };
    const alert = workspaceLiveRosterAlert(
      operator,
      program,
      document,
      acceptedConnection,
      bundle.program.cursor,
    );
    expect(alert?.observed.map((p) => p.displayName).sort()).toEqual(['卡油兔克', '广州老头乐']);
    expect(alert?.absent.map((p) => p.displayName).sort()).toEqual(['北极光五号', '星火五号']);
    expect(alert?.syncStatus).toBe('网站实时同步仍在进行，人员差异待核对。');
    expect(
      workspaceLiveRosterAlert(operator, program, null, acceptedConnection, bundle.program.cursor),
    ).toBeNull();
    expect(
      workspaceLiveRosterAlert(
        operator,
        program,
        document,
        { ...acceptedConnection, activeMatchId: 'other' },
        bundle.program.cursor,
      ),
    ).toBeNull();
    const missingAccount = {
      ...document,
      entrants: {
        ...document.entrants,
        a: {
          ...document.entrants.a,
          players: document.entrants.a.players.map((p, i) =>
            i === 4 ? { ...p, steam64: null } : p,
          ),
        },
      },
    };
    expect(
      workspaceLiveRosterAlert(
        operator,
        program,
        missingAccount,
        acceptedConnection,
        bundle.program.cursor,
      ),
    ).toBeNull();
    expect(
      workspaceLiveRosterAlert(operator, program, document, acceptedConnection, {
        ...bundle.program.cursor,
        mapEpoch: bundle.program.cursor.mapEpoch + 1,
      }),
    ).toBeNull();
    expect(
      (await app.inject('/local/v1/live-snapshot')).json<LiveSnapshotV1>().capability,
    ).toMatchObject({ identity: 'degraded', lineupMismatchOnly: true, canonicalTeams: true });
    expect((await app.inject('/local/v1/rivalhub-connection')).json()).toMatchObject({
      sourceReady: true,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/rivalhub/source/claim',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(outgoing.find((request) => request.operation === 'claim')?.body).toMatchObject({
      allowLineupMismatch: true,
      lineupSteam64: expect.arrayContaining(changed.map((p) => p.steam64)),
    });
    await push(changed);
    await expect
      .poll(() =>
        outgoing.some(
          (request) =>
            request.operation === 'reliable' &&
            (request.body as { event: ReliableEventV1 }).event.kind === 'map_started',
        ),
      )
      .toBe(true);
    const start = outgoing.find(
      (request) =>
        request.operation === 'reliable' &&
        (request.body as { event: ReliableEventV1 }).event.kind === 'map_started',
    )!.body as { event: ReliableEventV1 };
    expect(start.event.evidence).toMatchObject({ identity: 'degraded', lineupMismatchOnly: true });
    await expect.poll(() => connection.view().liveDelivery.status).toBe('accepted');
    const live = outgoing.find((request) => request.operation === 'live')!.body as LiveSnapshotV1;
    expect(live.capability).toMatchObject({ identity: 'degraded', lineupMismatchOnly: true });
    expect(
      live.players
        .filter((p) => p.sourcePlayerId.startsWith('7656119809999999'))
        .every((p) => p.canonicalPlayerId === null && p.identityEvidence === 'observed'),
    ).toBe(true);
    await page.goto('/workspace/left');
    const dialog = page.getByRole('dialog', { name: '本场上场选手／账号与网站首发不一致' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('广州老头乐');
    await expect(dialog).toContainText('卡油兔克');
    await expect(dialog).toContainText('网站实时同步仍在进行');
    await expect(dialog).not.toContainText('7656119');
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 3840, height: 2160 },
    ]) {
      await page.setViewportSize(viewport);
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.screenshot({ path: testInfo.outputPath('live-roster-alert.png') });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(
      (matchId) => localStorage.setItem('mizar.preflight.silenced-match.v1', matchId),
      manifest.match.matchId,
    );
    const reviewPage = await context.newPage();
    await reviewPage.addInitScript((address) => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(url, window.location.href);
          if (target.pathname.startsWith('/local/v1/')) target.host = new URL(address).host;
          super(target, protocols);
        }
      };
    }, address);
    await reviewPage.routeWebSocket(`ws://${new URL(address).host}/local/v1/**`, (socket) =>
      socket.connectToServer(),
    );
    await reviewPage.goto(new URL('/workspace/review?kind=roster', page.url()).toString());
    const manualReview = reviewPage.getByRole('dialog', {
      name: '本场上场选手／账号与网站首发不一致',
    });
    await expect(manualReview).toBeVisible();
    await expect(manualReview).toContainText('广州老头乐');
    await reviewPage.close();
    await page.evaluate(() => localStorage.removeItem('mizar.preflight.silenced-match.v1'));
    await push(changed);
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '查看人员差异' })).toBeVisible();
    await page.getByRole('button', { name: '查看人员差异' }).click();
    const popupPromise = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: '核对网站名单', exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(new URL(popup.url()).pathname + new URL(popup.url()).search).toBe('/matches?tab=roster');
    await expect(popup.getByRole('link', { name: '打开网站本场工作台' })).toHaveAttribute(
      'href',
      `${OFFICIAL_RIVALHUB_URL}/admin/${manifest.match.competition!.slug}/matches/${manifest.match.matchId}`,
    );
    await expect(popup.getByRole('button', { name: '刷新比赛资料与 BP' })).toBeVisible();
    await popup.close();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    // Different observed IDs re-open even if the game nickname stays unchanged.
    const nextDifference = changed.map((p, i) =>
      i === 4 ? { ...p, steam64: '76561198099999993' } : p,
    );
    const outsideControl = page.getByRole('button', { name: '比赛资料', exact: true });
    await outsideControl.focus();
    await push(nextDifference);
    await expect(dialog).toBeVisible();
    await expect(outsideControl).not.toBeFocused();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await push(starters);
    await expect(page.getByRole('button', { name: '查看人员差异' })).not.toBeVisible();
    await push(nextDifference);
    await expect(dialog).toBeVisible();
    // A new execution must not inherit an accepted LIVE from the previous one.
    await push(starters);
    const priorCursor = coordinator.getCurrent().program.cursor;
    await expect.poll(() => connection.view().liveDelivery.status).toBe('accepted');
    rejectMapStarts = true;
    await push(starters, true);
    expect(coordinator.getCurrent().program.cursor.mapEpoch).toBe(priorCursor.mapEpoch + 1);
    await push(nextDifference);
    await push(nextDifference);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText('网站实时同步仍在进行');
    await expect.poll(() => connection.view().liveDelivery.reason).toBe('map_start_rejected');
    await expect(dialog).toContainText('网站未接受本场开局');
    const newEpoch = coordinator.getCurrent().program.cursor.mapEpoch;
    expect(
      outgoing
        .filter((request) => request.operation === 'live')
        .some((request) => (request.body as LiveSnapshotV1).cursor.mapEpoch === newEpoch),
    ).toBe(false);
    // Incomplete observations do not invent a new account mismatch.
    await push(starters.slice(0, 8));
    await expect(dialog).not.toBeVisible();
    // A matched roster still needs real website acceptance. The health clock is
    // injected in this owned local Companion; no website or user data is touched.
    await push(starters);
    expect(coordinator.getCurrent().identity.state).toBe('matched');
    await app.inject('/local/v1/rivalhub-connection');
    healthOffset += 16_000;
    await push(starters);
    const syncDialog = page.getByRole('dialog', { name: '本场网站同步需要处理' });
    const outside = page.getByRole('button', { name: '比赛资料', exact: true });
    await outside.focus();
    await expect(syncDialog).toBeVisible();
    await expect(outside).not.toBeFocused();
    expect(await syncDialog.evaluate((element) => element.matches(':modal'))).toBe(true);
    await expect(syncDialog.getByRole('link', { name: '打开网站本场工作台' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sync-health-matched.png') });
    await syncDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await push(starters);
    await expect(syncDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '网站同步需处理' })).toBeVisible();
    await page.getByRole('button', { name: '网站同步需处理' }).click();
    rejectMapStarts = false;
    await syncDialog.getByRole('button', { name: '立即重试同步' }).click();
    await push(starters);
    await expect.poll(() => connection.view().liveDelivery.status).toBe('accepted');
    await expect(syncDialog).not.toBeVisible();
    await expect(
      page.getByText('操作已提交，等待网站接收本场新数据确认。', { exact: true }),
    ).not.toBeVisible();
    await expect(page.getByRole('button', { name: '网站同步需处理' })).not.toBeVisible();
    liveAccepted = false;
    healthOffset += 16_000;
    await push(starters);
    await expect(syncDialog).toBeVisible();
    await expect(syncDialog).not.toContainText('操作已提交，等待网站接收本场新数据确认。');
    await syncDialog.getByText('详情与诊断导出', { exact: true }).click();
    await expect(syncDialog.getByRole('button', { name: '导出诊断包', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sync-health-interrupted.png') });
    // Manually reopened alerts also disappear after an explicit stop or an
    // acknowledged source transfer; neither leaves the former warning behind.
    const sourceCommand = async (operation: 'claim' | 'release') => {
      await push(starters);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/operator/rivalhub/source/${operation}`,
            headers: { origin: 'http://127.0.0.1:3000' },
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
    };
    const reopen = async () => {
      await syncDialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '网站同步需处理' }).click();
      await expect(syncDialog).toBeVisible();
    };
    await reopen();
    await sourceCommand('release');
    await expect(syncDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '网站同步需处理' })).not.toBeVisible();
    await sourceCommand('claim');
    await app.inject('/local/v1/rivalhub-connection');
    healthOffset += 16_000;
    await push(starters);
    await expect(syncDialog).toBeVisible();
    await reopen();
    otherDevice = true;
    await sourceCommand('claim');
    await expect(syncDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '网站同步需处理' })).not.toBeVisible();
    // Reuse the existing CI browser-evidence artifact, including successful runs.
    const evidence = '.agent-tmp/test-evidence/ui-sync-health';
    await mkdir(evidence, { recursive: true });
    for (const name of ['sync-health-matched.png', 'sync-health-interrupted.png'])
      await copyFile(testInfo.outputPath(name), join(evidence, name));
  } finally {
    // Stop UI polling and drain its route callbacks before closing the owned server.
    await page.close();
    await context.unrouteAll({ behavior: 'wait' });
    await app.close();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('filtered roster warning keeps the remaining issue action and target together', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  const artifact = JSON.parse(
    readFileSync(
      'apps/web/src/program/fixtures/generated/epl-program-fixtures.generated.json',
      'utf8',
    ),
  ) as {
    fixtures: Record<
      string,
      { snapshot: import('../../packages/protocol/src/program.js').ProgramSnapshot }
    >;
  };
  const program = artifact.fixtures['epl-live']!.snapshot;
  program.payload.map.phase = 'live';
  const operator = JSON.parse(
    readFileSync('tests/acceptance/fixtures/preflight-operator.json', 'utf8'),
  ) as import('../../packages/protocol/src/operator.js').OperatorSnapshot;
  operator.payload.identity.state = 'degraded';
  operator.payload.identity.issues = [
    {
      code: 'unexpected_human_steam64',
      severity: 'warning',
      message: '上场账号与网站名单不同',
      sourcePlayerId: null,
      steam64: null,
      canonicalPlayerId: null,
      affectsExpectedLineup: null,
      entryId: null,
      observedSide: null,
      mapSide: null,
    },
  ];
  operator.payload.matchContext.sourceFailure = 'network';
  const document = JSON.parse(
    JSON.stringify(toMatchDocumentV1(sampleManifest())),
  ) as WireMatchDocument;
  document.matchId = program.payload.match!.matchId;
  for (const [key, side] of [
    ['a', 'CT'],
    ['b', 'T'],
  ] as const) {
    document.entrants[key].players = program.payload.players
      .filter((p) => p.side === side)
      .map((p, i) => ({
        playerId: p.sourcePlayerId,
        steam64: key === 'a' && i === 0 ? '76561198000000000' : p.sourcePlayerId,
        displayName: p.displayName ?? '网站选手',
        isStarter: true,
        avatarUrl: null,
      }));
  }
  await page.routeWebSocket('**/local/v1/operator', (ws) => ws.send(JSON.stringify(operator)));
  await page.routeWebSocket('**/local/v1/program', (ws) => ws.send(JSON.stringify(program)));
  await page.route('**/local/v1/match-document', (route) =>
    route.fulfill({ json: { document, source: 'rivalhub' } }),
  );
  await page.route('**/local/v1/rivalhub-connection', (route) =>
    route.fulfill({
      json: {
        paired: true,
        activeMatchId: document.matchId,
        activeSourceMatchId: null,
        sourceReady: false,
      },
    }),
  );
  let refreshes = 0;
  await page.route('**/operator/rivalhub/refresh', (route) => {
    refreshes++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  const dialog = page.getByRole('dialog', { name: '本场上场选手／账号与网站首发不一致' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const attention = page.locator('.workspace-attention');
  await expect(attention).toContainText('网站比赛资料更新失败');
  await expect(attention.getByRole('button', { name: '重试更新资料', exact: true })).toBeVisible();
  await attention.getByRole('button', { name: '重试更新资料', exact: true }).click();
  await expect.poll(() => refreshes).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath('filtered-issue-action-2k.png'),
    fullPage: false,
  });
});
