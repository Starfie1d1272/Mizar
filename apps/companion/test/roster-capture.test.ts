import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { buildApp } from '../src/app.js';
import { rosterCandidate, mergeObservedStarters } from '../src/match-context/roster-capture.js';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';

const ct = Array.from({ length: 5 }, (_, i) => ({
  steam64: `7656119800000000${i}`,
  displayName: `Observed ${i}`,
}));
const t = Array.from({ length: 5 }, (_, i) => ({
  steam64: `7656119800000001${i}`,
  displayName: `Observed ${i + 5}`,
}));
const evidence = { ct, t, ctName: 'Alpha', tName: 'Beta', sourceGeneration: 1, mapEpoch: 2 };

it('keeps canonical names, stable IDs, avatars and substitutes when changing starters', () => {
  const existing = [
    {
      playerId: 'stable',
      steam64: ct[0]!.steam64,
      displayName: 'Canonical',
      avatarUrl: '/local/avatar.png',
      isStarter: false,
    },
    {
      playerId: 'sub',
      steam64: '76561198000000099',
      displayName: 'Sub',
      avatarUrl: null,
      isStarter: true,
    },
  ];
  const merged = mergeObservedStarters(existing, ct);
  expect(merged).toHaveLength(6);
  expect(merged[0]).toEqual({ ...existing[0], isStarter: true });
  expect(merged[1]).toEqual({ ...existing[1], isStarter: false });
  expect(
    merged.slice(2).every((item) => item.isStarter && item.avatarUrl === null && item.playerId),
  ).toBe(true);
});

it('maps exact team names, prefers full canonical roster proof and rejects stale disk commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-capture-'));
  const path = join(root, 'local.json');
  const store = new LocalTournamentStore(path);
  try {
    const match = await store.createMatch({
      teamA: 'Alpha',
      teamB: 'Beta',
      format: 'bo3',
      mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    expect(rosterCandidate(evidence, match, 'one')?.ctEntrant).toBe('a');
    expect(rosterCandidate({ ...evidence, ctName: 'ALPHA' }, match, 'one')?.ctEntrant).toBe(null);
    const withRoster = {
      ...match,
      entrants: {
        a: { ...match.entrants.a, players: mergeObservedStarters([], t) },
        b: { ...match.entrants.b, players: mergeObservedStarters([], ct) },
      },
    };
    expect(rosterCandidate(evidence, withRoster, 'one')?.ctEntrant).toBe('b');
    const overlapping = mergeObservedStarters([], [...ct, ...t]);
    const ambiguous = {
      ...match,
      entrants: {
        a: { ...match.entrants.a, players: overlapping },
        b: { ...match.entrants.b, players: overlapping },
      },
    };
    // Even matching names cannot override contradictory canonical identity evidence.
    expect(rosterCandidate(evidence, ambiguous, 'one')?.ctEntrant).toBe(null);
    expect(rosterCandidate(evidence, match, 'two')?.revision).not.toBe(
      rosterCandidate(evidence, match, 'one')?.revision,
    );
    expect(rosterCandidate({ ...evidence, mapEpoch: 3 }, match, 'one')?.revision).not.toBe(
      rosterCandidate(evidence, match, 'one')?.revision,
    );
    const bytes = await readFile(path, 'utf8');
    let checks = 0;
    await expect(store.saveMatch(withRoster, () => ++checks < 2)).rejects.toThrow(
      'local_evidence_changed',
    );
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(store.getSnapshot().matches[0]).toEqual(match);
    await store.saveMatch(withRoster);
    const reused = await store.createMatch({
      teamA: '',
      teamB: '',
      teamAId: match.entrants.a.entryId,
      teamBId: match.entrants.b.entryId,
      format: 'bo1',
      mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    expect(reused.entrants.a.players).toEqual(withRoster.entrants.a.players);
    expect(rosterCandidate(null, match, 'one')).toBe(null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'server quick create explicitly reuses saved Teams = %s, keeps canonical assets and rejects stale candidates',
  async (reuse) => {
    const root = await mkdtemp(join(tmpdir(), 'mizar-server-create-'));
    const path = join(root, 'local.json');
    const store = new LocalTournamentStore(path);
    const seed = await store.createMatch({
      teamA: 'Alpha',
      teamB: 'Beta',
      format: 'bo3',
      mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    const players = mergeObservedStarters([], ct).map((player, i) => ({
      ...player,
      displayName: `Canonical ${i}`,
      avatarUrl: '/local/avatar.png',
    }));
    const sub = {
      playerId: 'saved-sub',
      steam64: '76561198000000099',
      displayName: 'Substitute',
      avatarUrl: null,
      isStarter: true,
    };
    const enriched = {
      ...seed,
      entrants: {
        ...seed.entrants,
        a: { ...seed.entrants.a, logoUrl: '/local/logo.png', players: [...players, sub] },
      },
    };
    await store.saveMatch(enriched);
    await writeFile(
      path,
      JSON.stringify({ ...store.getSnapshot(), selectedMatchId: null, selectedAt: null }),
    );
    let currentEvidence = evidence;
    const spy = vi
      .spyOn(ProjectionCoordinator.prototype, 'getRosterEvidence')
      .mockImplementation(() => currentEvidence);
    const app = buildApp({
      matchManifestPath: join(root, 'manifest.json'),
      localTournamentPath: path,
    });
    const headers = { origin: 'http://127.0.0.1:3000' };
    const get = async () =>
      (await app.inject('/local/v1/roster-candidate')).json<{
        candidate: NonNullable<ReturnType<typeof rosterCandidate>>;
      }>().candidate;
    const create = (
      candidate: NonNullable<ReturnType<typeof rosterCandidate>>,
      extra: Record<string, unknown> = {},
    ) =>
      app.inject({
        method: 'POST',
        url: '/operator/local-match/create-from-server',
        headers,
        payload: {
          format: 'bo3',
          expectedContextRevision: candidate.contextRevision,
          expectedSourceGeneration: candidate.sourceGeneration,
          expectedMapEpoch: candidate.mapEpoch,
          candidateRevision: candidate.revision,
          ...extra,
        },
      });
    try {
      const candidate = await get();
      expect(candidate.teamOptions).toEqual({
        ct: [{ teamId: seed.entrants.a.entryId, name: 'Alpha' }],
        t: [{ teamId: seed.entrants.b.entryId, name: 'Beta' }],
      });
      currentEvidence = { ...evidence, sourceGeneration: 2 };
      expect((await create(candidate)).statusCode).toBe(409);
      expect((await create(await get(), { teamAId: 'nonexistent' })).statusCode).toBe(409);
      const request = await create(
        await get(),
        reuse ? { teamAId: seed.entrants.a.entryId, teamBId: seed.entrants.b.entryId } : {},
      );
      expect(request.statusCode, request.body).toBe(200);
      const envelope = (await app.inject('/local/v1/match-document')).json<{
        document: typeof seed;
      }>();
      expect(envelope.document.matchId).not.toBe(seed.matchId);
      if (reuse) {
        expect(envelope.document.entrants.a).toMatchObject({
          entryId: seed.entrants.a.entryId,
          logoUrl: '/local/logo.png',
        });
        expect(envelope.document.entrants.a.players.slice(0, 5)).toEqual(players);
        expect(envelope.document.entrants.a.players[5]).toEqual({ ...sub, isStarter: false });
      } else {
        expect(envelope.document.entrants.a.entryId).not.toBe(seed.entrants.a.entryId);
        expect(envelope.document.entrants.a.logoUrl).toBeNull();
      }
      const view = (await app.inject('/local/v1/tournament')).json<{
        teams: unknown[];
        matches: (typeof seed)[];
      }>();
      expect(view.teams).toHaveLength(reuse ? 2 : 4);
      expect(view.matches.find((match) => match.matchId === seed.matchId)).toEqual(enriched);
    } finally {
      await app.close();
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
