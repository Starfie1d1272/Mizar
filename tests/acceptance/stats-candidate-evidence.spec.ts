import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { RivalHubConnection } from '../../apps/companion/src/match-context/rivalhub-connection.js';
import { HudConfigStore } from '../../apps/companion/src/hud-config/store.js';
import { toMatchContext, type BroadcastManifest } from '../../packages/rivalhub/src/index.js';
import { broadcastStatsSchema } from '../../packages/protocol/src/broadcast-stats.js';
import { broadcastStatsPresentationSchema } from '../../packages/protocol/src/broadcast-stats-presentation.js';

test('assembled Companion serves historical cards to multiple browsers without extra website requests', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-candidate-history-'));
  const stats = broadcastStatsSchema.parse(
    JSON.parse(await readFile('tests/fixtures/rivalhub-provider-stats-v1.json', 'utf8')),
  );
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
  let currentStats = structuredClone(stats);
  let upstreamRequests = 0;
  const upstream = createServer((request, response) => {
    const path = new URL(request.url!, 'http://127.0.0.1');
    if (path.pathname === '/api/mizar/stats') {
      upstreamRequests++;
      response.setHeader('content-type', 'application/json');
      response.setHeader('etag', '"snapshot"');
      response.end(JSON.stringify(currentStats));
    } else if (path.pathname === '/api/mizar/match') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(typedManifest));
    } else {
      response.statusCode = 503;
      response.end();
    }
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string')
    throw new Error('missing upstream address');
  const configPath = join(directory, 'connection.json');
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      credential: 'test',
      installationId: 'test',
      competitionId: stats.competitionId,
      displayName: 'test',
    }),
  );
  const connection = new RivalHubConnection(configPath);
  await connection.load();
  const binding = {
    manifest: typedManifest,
    context: toMatchContext(typedManifest),
    origin: 'online' as const,
    freshness: 'fresh' as const,
    diagnostics: [],
  };
  const hudConfigStore = new HudConfigStore();
  await hudConfigStore.load();
  const app = buildApp({
    hudConfigStore,
    matchManifestPath: join(directory, 'manifest.json'),
    matchContextBinding: binding,
    rivalhubConnection: connection,
    webRoot: resolve('apps/web/dist'),
    obsConfigPath: join(directory, 'obs.json'),
  });
  const browserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const json = async (path: string) => (await fetch(address + path)).json();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(address + path, {
        method: 'POST',
        headers: { origin: address, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };
    const config = await json('/local/v1/broadcast-presets');
    const builtin = config.modules.find((item: { kind: string }) => item.kind === 'program');
    const cloned = await post('/operator/broadcast-modules/clone', {
      moduleId: builtin.id,
      expectedRevision: builtin.revision,
      name: 'Candidate theme',
    });
    const customColors = {
      canvas: '#192837',
      blue: '#3060f0',
      gold: '#e0a020',
      white: '#eeeeee',
      muted: '#999999',
      shell: '#223344',
    };
    cloned.value.tokens = Object.fromEntries(
      Object.entries(customColors).map(([key, value]) => [`pulse.${key}`, value]),
    );
    const saved = await post('/operator/broadcast-modules/save', {
      value: cloned,
      expectedRevision: cloned.revision,
    });
    await post('/operator/broadcast-modules/apply', {
      moduleId: saved.id,
      expectedRevision: saved.revision,
      expectedActiveRevision: config.active.revision,
      requestId: randomUUID(),
    });
    const production = await json('/local/v1/production');
    const entered = await fetch(address + '/operator/production', {
      method: 'POST',
      headers: { origin: address, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enter', expectedRevision: production.revision }),
    });
    expect(entered.status).toBe(200);
    await expect.poll(async () => upstreamRequests).toBe(1);
    const projected = broadcastStatsPresentationSchema.parse(
      await json('/local/v1/broadcast-stats-presentation'),
    );
    const original = broadcastStatsSchema.parse(await json('/local/v1/broadcast-stats'));
    expect(original).toEqual(stats);
    expect(projected.maps.pages[0]!.rows[0]!.values[0].winRate).toBe(
      stats.entrants[0]!.mapPerformance.maps[0]!.winRate,
    );
    expect(projected.playerComparison.rating?.[0].value).toBe(
      stats.entrants[0]!.playerPerformance.players[0]!.rating,
    );
    const displayResponse = await fetch(address + '/local/v1/broadcast-display-config');
    expect(displayResponse.status).toBe(200);
    const waiting = await browserContext.newPage();
    await waiting.clock.install();
    await waiting.goto(address + '/program/waiting');
    await expect(waiting.locator('.program-scene--waiting')).toBeVisible();
    const readColors = (selector: string) =>
      waiting
        .locator(selector)
        .evaluate((node) =>
          Object.fromEntries(
            ['canvas', 'blue', 'gold', 'white', 'muted', 'shell'].map((name) => [
              name,
              getComputedStyle(node).getPropertyValue(`--mizar-broadcast-pulse-${name}`).trim(),
            ]),
          ),
        );
    const colors = await readColors('.program-scene--waiting');
    expect(colors).toEqual(customColors);
    await waiting.clock.fastForward(20_100);
    await expect(waiting.locator('.stats-insert')).toBeVisible();
    expect(await readColors('.stats-insert')).toEqual(colors);
    await waiting.screenshot({ path: testInfo.outputPath('waiting-card.png') });
    const standalone = await browserContext.newPage();
    await standalone.goto(address + '/program/stats?card=player-attributes');
    await expect(standalone.locator('.stats-insert__radar')).toBeVisible();
    const secondBrowser = await chromium.launch({ headless: true });
    const secondContext = await secondBrowser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    try {
      const other = await secondContext.newPage();
      await other.goto(address + '/program/stats?card=maps');
      await expect(other.locator('.stats-insert')).toBeVisible();
      const preview = await secondContext.newPage();
      await preview.goto(address + '/program/intermap?preview=1');
      await expect(preview.locator('.program-scene--intermap')).toBeVisible();
      await waiting.clock.fastForward(12_100);
      await expect(waiting.locator('.stats-insert h1')).toHaveText('地图表现');
      expect(upstreamRequests).toBe(1);
    } finally {
      await secondContext.close();
      await secondBrowser.close();
    }
    const settings = await browserContext.newPage();
    await settings.goto(address + '/settings?tab=rivalhub');
    await expect(settings.getByText(/本场统计：/)).toContainText('张可用');
    currentStats = structuredClone(stats);
    currentStats.revision = 'refreshed';
    currentStats.entrants[0]!.mapPerformance.maps[0]!.winRate = 0.25;
    currentStats.entrants[0]!.recentResults.results[0]!.opponent.name = 'Refreshed opponent';
    await settings.getByRole('button', { name: '刷新统计' }).click();
    await expect.poll(async () => upstreamRequests).toBe(2);
    await expect
      .poll(async () => (await json('/local/v1/broadcast-stats-presentation')).sourceRevision)
      .toBe('refreshed');
    expect(
      (await json('/local/v1/broadcast-stats-presentation')).maps.pages[0].rows[0].values[0]
        .winRate,
    ).toBe(0.25);
    expect(upstreamRequests).toBe(2);
    await expect(waiting.locator('.stats-insert')).toContainText('50.0%');
    await waiting.clock.fastForward(15_100);
    await expect(waiting.locator('.stats-insert h1')).toHaveText('近期战绩');
    await expect(waiting.locator('.stats-insert')).toContainText('Refreshed opponent');
    expect(upstreamRequests).toBe(2);
    console.log(
      JSON.stringify({
        candidate: '828467e229d418e3534d2720903dac1ba5832dda',
        upstreamRequests,
        colors,
        refreshRevision: 'refreshed',
      }),
    );
  } finally {
    await browserContext.close();
    await app.close();
    await new Promise<void>((resolveClose, reject) =>
      upstream.close((error) => (error ? reject(error) : resolveClose())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
