import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/companion/src/app.js';
import { HudConfigStore } from '../../apps/companion/src/hud-config/store.js';
import { RivalHubConnection } from '../../apps/companion/src/match-context/rivalhub-connection.js';
import { createProgramRuntime } from '../../apps/companion/src/runtime/program-runtime.js';
import { toMatchContext, type BroadcastManifest } from '../../packages/rivalhub/src/index.js';
import { broadcastStatsSchema } from '../../packages/protocol/src/broadcast-stats.js';

test('assembled app isolates late refresh on match switch and keeps the snapshot across map changes', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-candidate-switch-'));
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
    for (const [j, player] of manifest.entrants[side].roster.players.entries()) {
      if (j < entry.starters.length) {
        player.playerId = entry.starters[j]!.userId;
        player.displayName = entry.starters[j]!.nickname;
        player.avatarUrl = entry.starters[j]!.avatarUrl;
        player.isStarter = true;
      } else player.isStarter = false;
    }
  }
  const firstManifest = JSON.parse(
    JSON.stringify(manifest)
      .replaceAll('entry-m2-a', stats.entrants[0]!.entryId)
      .replaceAll('entry-m2-b', stats.entrants[1]!.entryId),
  ) as BroadcastManifest;
  const nextId = 'next-match';
  const secondManifest = structuredClone(firstManifest);
  secondManifest.match.matchId = nextId;
  secondManifest.revision = 'next-revision';
  const nextStats = structuredClone(stats);
  nextStats.matchId = nextId;
  nextStats.revision = 'next-stats';
  nextStats.entrants[0]!.name = 'Next match team';
  let upstreamRequests = 0;
  let releaseOld!: () => void;
  let signalOld!: () => void;
  const oldArrived = new Promise<void>((resolveSignal) => {
    signalOld = resolveSignal;
  });
  const upstream = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/mizar/stats') {
      upstreamRequests++;
      if (url.searchParams.get('matchId') === nextId) response.end(JSON.stringify(nextStats));
      else if (upstreamRequests === 1) response.end(JSON.stringify(stats));
      else {
        releaseOld = () => response.end(JSON.stringify({ ...stats, revision: 'late-old' }));
        signalOld();
      }
    } else if (url.pathname === '/api/mizar/match') {
      response.end(
        JSON.stringify(url.searchParams.get('matchId') === nextId ? secondManifest : firstManifest),
      );
    } else {
      response.statusCode = 503;
      response.end();
    }
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('missing upstream');
  const path = join(directory, 'connection.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      credential: 'test',
      installationId: 'test',
      competitionId: stats.competitionId,
      displayName: 'test',
    }),
  );
  const connection = new RivalHubConnection(path);
  await connection.load();
  const hudConfigStore = new HudConfigStore();
  await hudConfigStore.load();
  const observedMaps: string[] = [];
  const programRuntime = createProgramRuntime('candidate-switch', {
    liveSession: { kind: 'bound', liveSessionId: 'candidate-switch-session' },
  });
  const app = buildApp({
    programRuntime,
    matchManifestPath: join(directory, 'manifest.json'),
    matchContextBinding: {
      manifest: firstManifest,
      context: toMatchContext(firstManifest),
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
    rivalhubConnection: connection,
    hudConfigStore,
    obsConfigPath: join(directory, 'obs.json'),
    webRoot: resolve('apps/web/dist'),
    gsiToken: 'test-gsi',
    onObservation: (observation) => {
      if (observation.telemetry.map?.name) observedMaps.push(observation.telemetry.map.name);
    },
  });
  const context = await browser.newContext();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const json = async (pathname: string) => (await fetch(address + pathname)).json();
    const post = (pathname: string, value: unknown) =>
      fetch(address + pathname, {
        method: 'POST',
        headers: { origin: address, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    const production = await json('/local/v1/production');
    expect(
      (
        await post('/operator/production', {
          action: 'enter',
          expectedRevision: production.revision,
        })
      ).status,
    ).toBe(200);
    await expect.poll(() => upstreamRequests).toBe(1);
    const page = await context.newPage();
    await page.goto(address + '/program/stats?card=maps');
    await expect(page.locator('.stats-insert')).toContainText(stats.entrants[0]!.name);
    const oldRefresh = post('/operator/rivalhub/stats/refresh', {});
    await oldArrived;
    const selected = await post('/operator/rivalhub/select', { matchId: nextId, activate: true });
    const selectionBody = await selected.text();
    expect(selected.status, selectionBody).toBe(200);
    await expect.poll(() => upstreamRequests).toBe(3);
    releaseOld();
    await oldRefresh;
    await expect
      .poll(async () => (await json('/local/v1/broadcast-stats-presentation'))?.matchId)
      .toBe(nextId);
    expect((await json('/local/v1/broadcast-stats-presentation')).sourceRevision).toBe(
      'next-stats',
    );
    await expect(page.locator('.stats-insert')).toContainText('Next match team');
    expect(upstreamRequests).toBe(3);
    const players = [
      ...secondManifest.entrants.a.roster.players.filter((p) => p.isStarter),
      ...secondManifest.entrants.b.roster.players.filter((p) => p.isStarter),
    ];
    for (const map of ['de_dust2', 'de_inferno']) {
      const body = {
        auth: { token: 'test-gsi' },
        map: {
          name: map,
          phase: 'warmup',
          round: 0,
          team_ct: { name: 'Alpha', score: 0 },
          team_t: { name: 'Beta', score: 0 },
        },
        round: { phase: 'freezetime' },
        allplayers: Object.fromEntries(
          players.map((p, i) => [
            p.steam64!,
            {
              steamid: p.steam64,
              name: p.displayName,
              team: i < 5 ? 'CT' : 'T',
              observer_slot: i,
              activity: 'playing',
              state: { health: 100 },
            },
          ]),
        ),
      };
      expect((await post('/gsi', body)).status).toBe(204);
      await expect.poll(() => programRuntime.getSnapshot().current.map.name).toBe(map);
    }
    expect(observedMaps).toEqual(['de_dust2', 'de_inferno']);
    expect(upstreamRequests).toBe(3);
    console.log(
      JSON.stringify({
        candidate: '828467e229d418e3534d2720903dac1ba5832dda',
        upstreamRequests,
        observedMaps,
        active: (await json('/local/v1/broadcast-stats-presentation')).matchId,
      }),
    );
  } finally {
    if (releaseOld) releaseOld();
    await context.close();
    await app.close();
    await new Promise<void>((resolveClose, reject) =>
      upstream.close((error) => (error ? reject(error) : resolveClose())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
