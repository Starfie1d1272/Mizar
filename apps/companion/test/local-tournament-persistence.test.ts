import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-store-'));
  directories.push(directory);
  const path = join(directory, 'tournament.json');
  const store = new LocalTournamentStore(path);
  const players = (prefix: string) =>
    Array.from({ length: 32 }, (_, i) => ({
      playerId: `${prefix}${i}`,
      steam64: null,
      displayName: `Player ${i}`,
      avatarUrl: null,
      isStarter: i < 5,
    }));
  const first = await store.createMatch({
    teamA: 'Team A',
    teamB: 'Team B',
    format: 'bo3',
    mapPool: ['de_dust2'],
    playersA: players('a'),
    playersB: players('b'),
  });
  const state = store.getSnapshot();
  const matches = Array.from({ length: 150 }, (_, i) => ({ ...first, matchId: `match-${i}` }));
  return {
    path,
    state: {
      ...state,
      matches,
      events: state.events.map((event) => ({ ...event, matchIds: matches.map((m) => m.matchId) })),
      selectedMatchId: matches[0]!.matchId,
    },
  };
}

it('recovers an old indented store above 2 MB without losing data, and keeps later writes reloadable', async () => {
  const { path, state } = await fixture();
  const original = `${JSON.stringify(state, null, 2)}\n`;
  expect(Buffer.byteLength(original)).toBeGreaterThan(2_000_000);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(2_000_000);
  await writeFile(path, original);
  const store = new LocalTournamentStore(path);
  await store.load();
  expect(store.getSnapshot()).toEqual(state);
  const digest = createHash('sha256').update(original).digest('hex');
  expect(await readFile(`${path}.before-compact-json-${digest}.json`, 'utf8')).toBe(original);
  expect((await readFile(path)).length).toBeLessThanOrEqual(2_000_000);
  await store.saveMatch({ ...state.matches[0]!, stageLabel: 'Updated stage' });
  const restarted = new LocalTournamentStore(path);
  await restarted.load();
  expect(restarted.getSnapshot()).toEqual(store.getSnapshot());
});

it('rejects over-budget writes and invalid oversized recovery without replacing the original', async () => {
  const { path, state } = await fixture();
  // Approach the real byte ceiling with valid ordinary player metadata.
  const withNameLength = (padding: number) => ({
    ...state,
    matches: state.matches.map((match) => ({
      ...match,
      entrants: {
        a: {
          ...match.entrants.a,
          players: match.entrants.a.players.map((p) => ({
            ...p,
            displayName: 'x'.repeat(padding),
          })),
        },
        b: match.entrants.b,
      },
    })),
  });
  const smallestBytes = Buffer.byteLength(JSON.stringify(withNameLength(1)));
  const padding = 1 + Math.floor((1_990_000 - smallestBytes) / (state.matches.length * 32));
  expect(padding).toBeLessThanOrEqual(256);
  const near = withNameLength(padding);
  await writeFile(path, JSON.stringify(near));
  const store = new LocalTournamentStore(path);
  await store.load();
  const original = await readFile(path);
  const document = store.getSnapshot().matches[0]!;
  await expect(
    store.saveMatch({
      ...document,
      entrants: {
        ...document.entrants,
        a: {
          ...document.entrants.a,
          players: document.entrants.a.players.map((p) => ({
            ...p,
            avatarUrl: `https://example.com/${'x'.repeat(2000)}`,
          })),
        },
      },
    }),
  ).rejects.toThrow('local_store_too_large');
  expect((await readFile(path)).equals(original)).toBe(true);
  expect(store.getSnapshot()).toEqual(near);

  const invalid = `${JSON.stringify({ ...state, selectedMatchId: 'missing' }, null, 2)}\n`;
  await writeFile(path, invalid);
  await expect(new LocalTournamentStore(path).load()).rejects.toThrow('local_selection_invalid');
  expect(await readFile(path, 'utf8')).toBe(invalid);
});
