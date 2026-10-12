import type { MatchDocumentV1 } from '../../packages/core/src/match-context/index.js';
import type { SeriesBindingView } from '../../packages/protocol/src/operator.js';
import { expect, test } from './companion-isolation.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { toMatchContext, type BroadcastManifest } from '../../packages/rivalhub/src/index.js';
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
