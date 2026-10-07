import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveScheduleNeighborhood } from '@mizar/core/match-context';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { parseMatchDocumentV1 } from '@mizar/protocol/context';
import {
  toMatchDocumentV1,
  toScheduleWindowV1,
  validateBroadcastManifest,
  validateBroadcastScheduleWindow,
} from '@mizar/rivalhub';
import { describe, expect, it } from 'vitest';

import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import { localDocumentBindingManifest } from '../src/match-context/local-document-adapter.js';

describe('Mizar local tournament input', () => {
  it('creates a match without BP, reuses teams and derives event schedule after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-local-input-'));
    try {
      const file = join(directory, 'local-tournament.json');
      const store = new LocalTournamentStore(file);
      await store.load();
      const first = await store.createMatch({
        teamA: 'NJU A',
        teamB: 'NJU B',
        format: 'bo3',
        mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
      });
      expect(first.veto).toEqual([]);
      expect(first.maps).toEqual([]);
      expect(first.entrants.a.players).toEqual([]);
      const eventId = first.competition?.competitionId ?? 'missing-event';
      expect(store.scheduleWindow(eventId)?.from).toBeNull();
      await store.saveEvent({
        eventId,
        name: '校园赛',
        logoUrl: null,
        themeColor: null,
        mapPool: ['de_ancient', 'de_mirage'],
      });
      expect(store.getSnapshot().matches[0]?.mapPool).toEqual(['de_ancient', 'de_mirage']);
      const updatedFirst = store.getSnapshot().matches[0]!;
      const second = await store.createMatch({
        eventId,
        teamA: 'NJU A',
        teamB: 'NJU C',
        teamAId: first.entrants.a.entryId,
        format: 'bo1',
        mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
      });
      expect(second.entrants.a.entryId).toBe(first.entrants.a.entryId);
      await store.saveMatch({
        ...updatedFirst,
        scheduledAt: '2026-09-28T10:00:00.000Z',
        stageLabel: '瑞士赛',
        stage: '瑞士赛',
        matchLabel: '第一场',
      });
      await store.saveMatch({ ...second, scheduledAt: '2026-09-28T12:00:00.000Z' });
      const window = store.scheduleWindow(eventId);
      expect(window?.matches.map((item) => item.matchId)).toEqual([first.matchId, second.matchId]);
      expect(deriveScheduleNeighborhood(window, first.matchId).next?.matchId).toBe(second.matchId);
      await store.reorder(eventId, [second.matchId, first.matchId]);
      expect(
        deriveScheduleNeighborhood(store.scheduleWindow(eventId), first.matchId).previous?.matchId,
      ).toBe(second.matchId);
      const recovered = new LocalTournamentStore(file);
      await recovered.load();
      expect(recovered.getSnapshot().selectedMatchId).toBe(second.matchId);
      expect(recovered.getSnapshot().events[0]?.matchIds).toEqual([second.matchId, first.matchId]);
      const selected = await recovered.selectMatch(first.matchId);
      expect(localDocumentBindingManifest(selected).veto).toEqual([]);
      const persisted: unknown = JSON.parse(await readFile(file, 'utf8'));
      expect(persisted).toHaveProperty('matches.0.schemaVersion', 'mizar.match-document.v1');
      expect(await readFile(file, 'utf8')).not.toContain('rivalhub.broadcast-manifest.v1');
      const distinct = await recovered.createMatch({
        eventId,
        teamA: 'NJU A',
        teamB: 'NJU B',
        format: 'bo1',
        mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
      });
      expect(distinct.entrants.a.entryId).not.toBe(first.entrants.a.entryId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('adapts the current RivalHub fixture and rejects unsupported or malformed input', async () => {
    const file = join(
      process.cwd(),
      'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json',
    );
    const manifest: unknown = JSON.parse(await readFile(file, 'utf8'));
    const document = toMatchDocumentV1(manifest);
    expect(document.schemaVersion).toBe('mizar.match-document.v1');
    expect(document.competition?.logoUrl).toBeNull();
    expect(document.entrants.a.players).toHaveLength(6);
    expect(document.maps).toHaveLength(3);
    expect(document.veto.length).toBeGreaterThan(0);
    expect(document.mapPool).toEqual([]);
    expect(document.competition).not.toHaveProperty('slug');
    expect(document).not.toHaveProperty('stageKey');
    const validated = validateBroadcastManifest(manifest);
    if (!validated.ok) throw new Error('RivalHub fixture invalid');
    const enriched = toMatchDocumentV1({
      ...validated.value,
      match: {
        ...validated.value.match,
        mapPool: ['de_ancient', 'de_mirage'],
        stageKey: 'swiss',
        stageLabel: '瑞士赛',
        startedAt: '2026-09-28T10:00:00.000Z',
        competition: {
          ...validated.value.match.competition,
          logoUrl: 'https://example.invalid/event.png',
        },
      },
    });
    expect(enriched.mapPool).toEqual(['de_ancient', 'de_mirage']);
    expect(enriched.stage).toBe('swiss');
    expect(enriched.stageLabel).toBe('瑞士赛');
    expect(enriched.startedAt).toBe('2026-09-28T10:00:00.000Z');
    expect(enriched.competition?.logoUrl).toBe('https://example.invalid/event.png');
    const scheduleFile = join(
      process.cwd(),
      'packages/rivalhub/test/fixtures/broadcast-schedule-window-v1.valid.json',
    );
    const scheduleFixture: unknown = JSON.parse(await readFile(scheduleFile, 'utf8'));
    const validatedSchedule = validateBroadcastScheduleWindow(scheduleFixture);
    if (!validatedSchedule.ok) throw new Error('RivalHub schedule fixture invalid');
    const schedule = toScheduleWindowV1(scheduleFixture);
    expect(schedule.matches.map((match) => match.matchId)).toEqual(
      validatedSchedule.value.matches.map((match) => match.matchId),
    );
    expect(schedule.matches[0]?.stageLabel).toBe(validatedSchedule.value.matches[0]?.stage);
    expect(() => parseMatchDocumentV1({ ...document, schemaVersion: 'old.brand.v1' })).toThrow();
    expect(() =>
      parseMatchDocumentV1({
        ...document,
        entrants: {
          ...document.entrants,
          b: { ...document.entrants.b, entryId: document.entrants.a.entryId },
        },
      }),
    ).toThrow();
  });
});

it('validates every durable Local asset and preserves existing match team snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-strict-'));
  try {
    const file = join(directory, 'store.json');
    const store = new LocalTournamentStore(file);
    const a = await store.createMatch({ teamA: 'A', teamB: 'B', format: 'bo3', mapPool: [] });
    const b = await store.createMatch({
      eventId: a.competition?.competitionId ?? 'missing-event',
      teamA: '',
      teamAId: a.entrants.a.entryId,
      teamB: 'C',
      format: 'bo1',
      mapPool: [],
    });
    await store.saveMatch({
      ...a,
      entrants: { ...a.entrants, a: { ...a.entrants.a, name: 'A updated' } },
    });
    expect(
      store.getSnapshot().matches.find((match) => match.matchId === b.matchId)?.entrants.a.name,
    ).toBe('A');
    const c = await store.createMatch({
      eventId: a.competition?.competitionId ?? 'missing-event',
      teamA: '',
      teamAId: a.entrants.a.entryId,
      teamB: 'D',
      format: 'bo1',
      mapPool: [],
    });
    expect(c.entrants.a.name).toBe('A updated');
    const valid = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> & {
      events: Record<string, unknown>[];
      teams: Record<string, unknown>[];
    };
    const mutations = [
      (state: typeof valid) => {
        state.extra = true;
      },
      (state: typeof valid) => {
        state.events[0]!.extra = true;
      },
      (state: typeof valid) => {
        state.events[0]!.mapPool = ['a', 'a'];
      },
      (state: typeof valid) => {
        state.teams[0]!.logoUrl = 'javascript:bad';
      },
      (state: typeof valid) => {
        state.teams[0]!.players = Array(33).fill({});
      },
      (state: typeof valid) => {
        state.teams = [];
      },
      (state: typeof valid) => {
        state.events[0]!.matchIds = ['unknown'];
      },
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(valid);
      mutate(corrupted);
      await writeFile(file, JSON.stringify(corrupted));
      await expect(new LocalTournamentStore(file).load()).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('persists and reloads an independent match without fabricating an event or roster', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-independent-input-'));
  try {
    const file = join(directory, 'local-tournament.json');
    const store = new LocalTournamentStore(file);
    await store.load();
    const parsed = validateBroadcastManifest(
      JSON.parse(
        await readFile(
          join(process.cwd(), 'packages/rivalhub/test/fixtures/rivalhub-provider-manifest-v1.json'),
          'utf8',
        ),
      ),
    );
    if (!parsed.ok) throw new Error('Invalid provider fixture');
    const fixture = {
      ...parsed.value,
      schemaVersion: 'rivalhub.broadcast-manifest.v2',
      match: {
        ...parsed.value.match,
        competition: null,
        stage: null,
        stageKey: null,
        stageLabel: null,
      },
      entrants: {
        a: { ...parsed.value.entrants.a, roster: { rosterId: null, players: [] } },
        b: { ...parsed.value.entrants.b, roster: { rosterId: null, players: [] } },
      },
    };
    const document = toMatchDocumentV1(fixture);
    await store.importLegacyMatch(document);
    await store.saveMatch(document);
    const reloaded = new LocalTournamentStore(file);
    await reloaded.load();
    const persisted = reloaded.getSnapshot();
    expect(persisted.events).toEqual([]);
    expect(persisted.matches[0]!.competition).toBeNull();
    expect(persisted.matches[0]!.entrants.a.players).toEqual([]);
    expect(localDocumentBindingManifest(document).schemaVersion).toBe(
      'rivalhub.broadcast-manifest.v2',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
