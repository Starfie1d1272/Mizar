import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { expect, it, vi } from 'vitest';

import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import * as durableJson from '../src/match-context/durable-json.js';

const rc29Fixture = new URL('./fixtures/rc29/local-tournament.json', import.meta.url);

it('retains the source on backup or replacement failure and can retry from preserved evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rc29-retry-'));
  const replace = vi.spyOn(durableJson, 'replaceDurableJson');
  try {
    const file = join(directory, 'local-tournament.json');
    const original = await readFile(rc29Fixture);
    const backup = `${file}.before-live-stream-url-${createHash('sha256').update(original).digest('hex')}.json`;
    await writeFile(file, original);
    await writeFile(backup, 'incomplete backup');
    await expect(new LocalTournamentStore(file).load()).rejects.toThrow(
      'local_link_backup_invalid',
    );
    expect(replace).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(original);
    expect(await readFile(backup, 'utf8')).toBe('incomplete backup');
    await rm(backup);
    replace.mockRejectedValueOnce(new Error('replacement interrupted'));
    await expect(new LocalTournamentStore(file).load()).rejects.toThrow('replacement interrupted');
    expect(await readFile(file)).toEqual(original);
    expect(await readFile(backup)).toEqual(original);
    const recovered = new LocalTournamentStore(file);
    await recovered.load();
    expect(recovered.getSnapshot().matches[0]!.commentators[0]!.liveStreamUrl).toBeNull();
    expect(await readFile(backup)).toEqual(original);
    expect(await readdir(directory)).toHaveLength(2);
  } finally {
    replace.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('atomically recycles selected matches, preserves shared assets and restores full documents after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-trash-'));
  try {
    const file = join(directory, 'store.json');
    const store = new LocalTournamentStore(file);
    const first = await store.createMatch({
      teamA: 'A',
      teamB: 'B',
      format: 'bo3',
      mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    const second = await store.createMatch({
      eventId: first.competition!.competitionId,
      teamA: 'A',
      teamB: 'C',
      teamAId: first.entrants.a.entryId,
      format: 'bo1',
      mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    const document = await store.saveMatch({
      ...first,
      scheduledAt: '2026-10-10T12:00:00.000Z',
      matchLabel: '保留的比赛',
      entrants: {
        ...first.entrants,
        a: { ...first.entrants.a, logoUrl: '/local/v1/local-assets/logo.png' },
      },
    });
    await store.selectMatch(first.matchId);
    const before = store.getSnapshot();
    await expect(store.trashMatch(first.matchId, () => false)).rejects.toThrow();
    expect(store.getSnapshot()).toEqual(before);
    // The final durable guard also catches an active binding change during write.
    let calls = 0;
    await expect(store.trashMatch(first.matchId, () => ++calls < 3)).rejects.toThrow();
    expect(store.getSnapshot()).toEqual(before);
    await store.trashMatch(first.matchId, () => true);
    await store.trashMatch(first.matchId, () => true);
    expect(store.getSnapshot().teams).toEqual(before.teams);
    expect(store.getSnapshot().matches).toEqual([second]);
    expect(store.getSnapshot().selectedMatchId).toBeNull();
    expect(store.getSnapshot().selectedAt).toBeNull();
    expect(
      store.scheduleWindow(first.competition!.competitionId)?.matches.map((match) => match.matchId),
    ).toEqual([second.matchId]);
    await expect(store.selectMatch(first.matchId)).rejects.toThrow();
    const recovered = new LocalTournamentStore(file);
    await recovered.load();
    expect(recovered.getSnapshot().trashedMatches).toHaveLength(1);
    expect(recovered.getSnapshot().trashedMatches[0]!.document).toEqual(document);
    await recovered.restoreMatch(first.matchId);
    await recovered.restoreMatch(first.matchId);
    expect(
      recovered.getSnapshot().matches.find((match) => match.matchId === first.matchId),
    ).toEqual(document);
    expect(recovered.getSnapshot().selectedMatchId).toBeNull();
    expect(recovered.getSnapshot().events[0]!.matchIds).toEqual([first.matchId, second.matchId]);
    expect(recovered.getSnapshot().trashedMatches).toEqual([]);
    await recovered.trashMatch(first.matchId, () => true);
    await recovered.saveEvent({ ...recovered.getSnapshot().events[0]!, name: '新赛事名' });
    await recovered.restoreMatch(first.matchId);
    expect(
      recovered.getSnapshot().matches.find((match) => match.matchId === first.matchId)?.competition
        ?.name,
    ).toBe('新赛事名');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
