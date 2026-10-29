import { readFile, mkdtemp, rm, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './companion-isolation.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { RivalHubConnection } from '../../apps/companion/src/match-context/rivalhub-connection.js';
import { toMatchContext, type BroadcastManifest } from '../../packages/rivalhub/src/index.js';
import { broadcastStatsSchema } from '../../packages/protocol/src/broadcast-stats.js';

test('production waiting rotates without telemetry and manual hold wins', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-production-'));
  const path = process.env.MIZAR_STATS_EVIDENCE ?? 'tests/fixtures/rivalhub-provider-stats-v1.json';
  const stats = broadcastStatsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const manifest = JSON.parse(
    await readFile('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json', 'utf8'),
  );
  manifest.match.matchId = stats.matchId;
  manifest.match.competition.competitionId = stats.competitionId;
  for (const [i, side] of ['a', 'b'].entries()) {
    const entry = stats.entrants[i]!;
    manifest.entrants[side].entryId = entry.entryId;
    manifest.entrants[side].name = entry.name;
    manifest.entrants[side].logoUrl = entry.logoUrl;
    for (const [j, player] of manifest.entrants[side].roster.players.entries()) {
      if (j < entry.starters.length) {
        player.playerId = entry.starters[j]!.userId;
        player.displayName = entry.starters[j]!.nickname;
        player.avatarUrl = entry.starters[j]!.avatarUrl;
        player.isStarter = true;
      } else player.isStarter = false;
    }
  }
  const typedManifest = JSON.parse(
    JSON.stringify(manifest)
      .replaceAll('entry-m2-a', stats.entrants[0]!.entryId)
      .replaceAll('entry-m2-b', stats.entrants[1]!.entryId),
  ) as BroadcastManifest;
  const configPath = join(directory, 'connection.json');
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: 'https://match.starfie1d.top',
      credential: 'test',
      installationId: 'test',
      competitionId: stats.competitionId,
      displayName: 'test',
    }),
  );
  let requests = 0;
  const connection = new RivalHubConnection(configPath, async (input) => {
    if (String(input).includes('/api/mizar/stats')) {
      requests++;
      return Response.json(stats);
    }
    return Response.json(typedManifest);
  });
  await connection.load();
  const binding = {
    manifest: typedManifest,
    context: toMatchContext(typedManifest),
    origin: 'online' as const,
    freshness: 'fresh' as const,
    diagnostics: [],
  };
  const app = buildApp({
    matchManifestPath: join(directory, 'manifest.json'),
    matchContextBinding: binding,
    rivalhubConnection: connection,
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await context.route(
      (url) => url.pathname.startsWith('/local/v1/') || url.pathname.startsWith('/operator/'),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const response = await app.inject({
          method: request.method() as 'GET' | 'POST',
          url: url.pathname + url.search,
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
    await page.addInitScript((host) => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(url, window.location.href);
          if (target.pathname.startsWith('/local/v1/')) target.host = new URL(host).host;
          super(target, protocols);
        }
      };
    }, address);
    await page.routeWebSocket(`ws://${new URL(address).host}/local/v1/**`, (socket) =>
      socket.connectToServer(),
    );
    const origin = 'http://127.0.0.1:4173';
    const production = (await app.inject('/local/v1/production')).json();
    const entered = await app.inject({
      method: 'POST',
      url: '/operator/production',
      headers: { origin },
      payload: { action: 'enter', expectedRevision: production.revision },
    });
    expect(entered.statusCode).toBe(200);
    await expect
      .poll(async () => (await app.inject('/local/v1/program-scenes')).json().director)
      .toMatchObject({ mode: 'blocked', blockCause: 'telemetry' });
    await expect
      .poll(async () => (await app.inject('/local/v1/broadcast-stats')).json())
      .toMatchObject({ matchId: stats.matchId });
    await page.goto('/program/waiting');
    await expect(page.locator('.stats-insert__content')).toBeVisible({ timeout: 25_000 });
    expect(requests).toBe(1);
    const shot = testInfo.outputPath('no-telemetry-automatic.png');
    await page.screenshot({ path: shot });
    const scenes = (await app.inject('/local/v1/program-scenes')).json();
    const held = await app.inject({
      method: 'POST',
      url: '/operator/program-scene',
      headers: { origin },
      payload: { sceneId: 'waiting', expectedRevision: scenes.revision },
    });
    expect(held.statusCode).toBe(200);
    await expect(page.locator('.stats-insert__content')).toHaveCount(0);
    await page.waitForTimeout(21_000);
    await expect(page.locator('.stats-insert__content')).toHaveCount(0);
    expect((await app.inject('/local/v1/program-scenes')).json().director.mode).toBe('manual');
    expect(requests).toBe(1);
    const manualShot = testInfo.outputPath('no-telemetry-manual.png');
    await page.screenshot({ path: manualShot });
    if (process.env.MIZAR_STATS_EVIDENCE) {
      const evidenceDir = '.agent-tmp/real-stats/production-no-telemetry';
      await mkdir(evidenceDir, { recursive: true });
      await copyFile(shot, join(evidenceDir, 'automatic.png'));
      await copyFile(manualShot, join(evidenceDir, 'manual.png'));
    }
  } finally {
    await page.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
