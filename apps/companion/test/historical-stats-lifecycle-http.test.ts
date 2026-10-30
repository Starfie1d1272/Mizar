import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { broadcastStatsSchema } from '@mizar/protocol/broadcast-stats';
import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import { buildApp } from '../src/app.js';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1-extended.json' with { type: 'json' };

// Synthetic fixture IDs are mapped to the existing local manifest solely for this test.
it('keeps one snapshot through map changes, refreshes and cancels across match and production changes over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-http-lifecycle-'));
  const manifest = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifest;
  const context = toMatchContext(manifest);
  const snapshot = structuredClone(fixture);
  snapshot.matchId = manifest.match.matchId;
  snapshot.competitionId = manifest.match.competition!.competitionId;
  for (const [i, side] of (['a', 'b'] as const).entries()) {
    const entrant = snapshot.entrants[i]!;
    const canonical = manifest.entrants[side];
    entrant.entryId = canonical.entryId;
    entrant.starters.forEach((p, j) => {
      p.userId = canonical.roster.players[j]!.playerId;
    });
    entrant.playerPerformance.players.forEach((p, j) => {
      p.userId = canonical.roster.players[j]!.playerId;
    });
    entrant.facts.players.forEach((p, j) => {
      p.userId = canonical.roster.players[j]!.playerId;
    });
    snapshot.support.sides[i]!.entryId = canonical.entryId;
  }
  const benchId = manifest.entrants.a.roster.players.find((p) => !p.isStarter)!.playerId;
  snapshot.entrants[0]!.facts.players.push({
    ...snapshot.entrants[0]!.facts.players[0]!,
    userId: benchId,
  });
  const wrongTeams = structuredClone(snapshot);
  wrongTeams.entrants[0]!.entryId = 'other-team';
  expect(broadcastStatsSchema.safeParse(wrongTeams).success).toBe(true);
  let statsRequests = 0;
  let failures = 1;
  let hold = false;
  const held: { response?: ServerResponse } = {};
  let aborted = 0;
  const provider = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/mizar/match') {
      response.end(
        JSON.stringify({
          ...manifest,
          match: { ...manifest.match, matchId: url.searchParams.get('matchId') },
        }),
      );
      return;
    }
    if (url.pathname !== '/api/mizar/stats') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    statsRequests++;
    if (hold) {
      hold = false;
      held.response = response;
      response.on('close', () => {
        if (!response.writableFinished) aborted++;
      });
      return;
    }
    if (failures > 0) {
      failures--;
      response.end(JSON.stringify({ ...wrongTeams, matchId: url.searchParams.get('matchId') }));
      return;
    }
    response.end(
      JSON.stringify({
        ...snapshot,
        matchId: url.searchParams.get('matchId'),
        privateEvidence: 'must-not-leak',
      }),
    );
  });
  await new Promise<void>((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string')
    throw new Error('missing provider address');
  const connectionPath = join(directory, 'connection.json');
  await writeFile(
    connectionPath,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${providerAddress.port}`,
      credential: 'secret',
      installationId: 'install',
      competitionId: snapshot.competitionId,
      displayName: 'test',
    }),
  );
  let now = 0;
  const target = (matchId = snapshot.matchId) => ({
    matchId,
    competitionId: snapshot.competitionId,
    entrantIds: [manifest.entrants.a.entryId, manifest.entrants.b.entryId] as const,
  });
  const connection = new RivalHubConnection(connectionPath, fetch, undefined, () => now);
  await connection.load();
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    matchContextBinding: {
      manifest,
      context,
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
    rivalhubConnection: connection,
    gsiToken: 'test-gsi-token',
  });
  const waitUntil = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await delay(10);
    expect(condition()).toBe(true);
  };
  const releaseHeld = (value: unknown) => held.response?.end(JSON.stringify(value));
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const get = (path: string) => fetch(`${address}${path}`);
    const post = (path: string, body: unknown) =>
      fetch(`${address}${path}`, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const production = async (action: string) => {
      const state = (await (await get('/local/v1/production')).json()) as { revision: string };
      return post('/operator/production', { action, expectedRevision: state.revision });
    };
    expect((await production('enter')).status).toBe(200);
    await waitUntil(() => statsRequests === 1);
    await waitUntil(() => connection.getStatsSnapshot(target()) === null);
    for (let i = 0; i < 12; i++) {
      failures = 1;
      now += 3_600_000;
      expect(await connection.stats(target())).toBeNull();
    }
    now += 3_600_000;
    expect((await connection.stats(target()))?.matchId).toBe(snapshot.matchId);
    const initialCount = statsRequests;
    for (const name of ['de_ancient', 'de_nuke']) {
      const response = await post('/gsi', {
        auth: { token: 'test-gsi-token' },
        provider: { appid: 730 },
        map: {
          name,
          phase: 'live',
          round: 1,
          team_ct: { name: manifest.entrants.a.name, score: 0 },
          team_t: { name: manifest.entrants.b.name, score: 0 },
        },
      });
      expect(response.status).toBe(204);
      const live = (await (await get('/local/v1/live-snapshot')).json()) as {
        map: { name: string | null };
      };
      expect(live.map.name).toBe(name);
      const result = await (await get('/local/v1/broadcast-stats-program')).text();
      expect(result).not.toContain('must-not-leak');
      expect(result).not.toContain(benchId);
      expect(JSON.parse(result).sourceRevision).toBe(snapshot.revision);
    }
    expect(statsRequests).toBe(initialCount);
    expect((await post('/operator/rivalhub/stats/refresh', {})).status).toBe(200);
    expect(statsRequests).toBe(initialCount + 1);
    hold = true;
    const lateRefresh = post('/operator/rivalhub/stats/refresh', {});
    await waitUntil(() => !!held.response);
    const selected = await post('/operator/rivalhub/select', {
      matchId: 'match-next',
      activate: true,
    });
    expect(selected.status).toBe(200);
    await waitUntil(() => connection.getStatsSnapshot(target('match-next')) !== null);
    expect(statsRequests).toBe(initialCount + 3);
    await waitUntil(() => aborted >= 1);
    releaseHeld(snapshot);
    await lateRefresh;
    expect(connection.getStatsSnapshot(target('match-next'))?.matchId).toBe('match-next');
    hold = true;
    delete held.response;
    const lateOnExit = post('/operator/rivalhub/stats/refresh', {});
    await waitUntil(() => !!held.response);
    expect((await production('finish')).status).toBe(200);
    await waitUntil(() => aborted >= 2);
    releaseHeld({ ...snapshot, matchId: 'match-next' });
    await lateOnExit;
    expect(connection.getStatsSnapshot(target('match-next'))).toBeNull();
  } finally {
    await app.close();
    await new Promise<void>((resolveClose, reject) =>
      provider.close((error) => (error ? reject(error) : resolveClose())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
