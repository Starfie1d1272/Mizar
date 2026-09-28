import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
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
