import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  toMatchContext,
  toScheduleWindow,
  type BroadcastManifest,
  type BroadcastScheduleWindowV1,
} from '../src/index.js';

const fixtureRoot = resolve(process.cwd(), 'packages/rivalhub/test/fixtures');

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

async function readJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(resolve(fixtureRoot, fileName), 'utf8')) as T;
}

describe('RivalHub DTO to Broadcast domain conversion', () => {
  it('converts the same Manifest deterministically without acquisition metadata', async () => {
    const manifest = await readJson<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const first = toMatchContext(manifest);
    const second = toMatchContext(manifest);

    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('schemaVersion');
    expect(first).not.toHaveProperty('revision');
    expect(first.matchId).toBe(manifest.match.matchId);
    expect(first.competition).toEqual(manifest.match.competition);
    expect(first.entrants.a.entryId).toBe(manifest.entrants.a.entryId);
    expect(first.entrants.a.players).toHaveLength(6);
    expect(first.entrants.a.players.at(-1)?.isStarter).toBe(false);
    expect(first.maps).toEqual([
      expect.objectContaining({ mapName: 'de_ancient', teamAStartSide: 'T' }),
      expect.objectContaining({ mapName: 'de_mirage', teamAStartSide: 'CT' }),
      expect.objectContaining({ mapName: 'de_nuke', teamAStartSide: null }),
    ]);
    expect(first.veto[2]).toMatchObject({ entryId: 'entry-m2-a', side: 'T' });
    expect(first.commentators[0]).toMatchObject({ userId: 'user-commentator-m2' });
    expect(first.scheduledAt).toBe(manifest.match.scheduledAt);
    expect(first.startedAt).toBeNull();
    expect(first.completedAt).toBeNull();
  });

  it('preserves a canonical startedAt exactly as supplied', async () => {
    const manifest = await readJson<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const candidate = structuredClone(manifest) as Mutable<BroadcastManifest>;
    candidate.match.startedAt = '2026-09-16T10:03:00.123+00:00';

    expect(toMatchContext(candidate).startedAt).toBe(candidate.match.startedAt);
  });

  it('maps the independent schedule contract to a lightweight domain window', async () => {
    const schedule = await readJson<BroadcastScheduleWindowV1>(
      'broadcast-schedule-window-v1.valid.json',
    );
    const window = toScheduleWindow(schedule);

    expect(window.competition).toEqual(schedule.competition);
    expect(window.matches.map((match) => match.matchId)).toEqual([
      'match-m2-00',
      'match-m2-01',
      'match-m2-unknown-time',
    ]);
    expect(window.matches[0]?.entrants).toEqual({
      a: { entryId: 'entry-m2-c', name: '赤焰战队', logoUrl: null },
      b: { entryId: 'entry-m2-d', name: '海风战队', logoUrl: null },
    });
    expect(window.matches[0]?.startedAt).toBe('2026-09-16T09:02:00.000Z');
  });
});

it('preserves test purpose across provider parsing, saved documents and schedule projections', async () => {
  const { validateBroadcastManifest, toMatchDocumentV1, toScheduleWindowV1 } =
    await import('../src/index.js');
  const { parseMatchDocumentV1, parseScheduleWindowV1 } = await import('@mizar/protocol/context');
  const { deriveScheduleNeighborhood } = await import('@mizar/core/match-context');
  const manifest = await readJson<BroadcastManifest>('broadcast-manifest-v1.valid.json');
  const testManifest = validateBroadcastManifest({
    ...manifest,
    match: {
      ...manifest.match,
      isTest: true,
      stage: 'test',
      stageKey: 'test',
      stageLabel: '测试赛',
      matchLabel: '测试赛',
    },
  });
  if (!testManifest.ok) throw new Error(JSON.stringify(testManifest));
  const document = toMatchDocumentV1(testManifest.value);
  expect(parseMatchDocumentV1(JSON.parse(JSON.stringify(document))).isTest).toBe(true);
  expect(document.entrants).toEqual(toMatchDocumentV1(manifest).entrants);
  const raw = await readJson<BroadcastScheduleWindowV1>('broadcast-schedule-window-v1.valid.json');
  const base = raw.matches[0]!;
  const window = toScheduleWindowV1({
    ...raw,
    matches: [
      { ...base, matchId: 'official-before', isTest: false, scheduledAt: '2026-09-16T10:00:00Z' },
      { ...base, matchId: document.matchId, isTest: true, scheduledAt: '2026-09-16T11:00:00Z' },
      { ...base, matchId: 'official-after', isTest: false, scheduledAt: '2026-09-16T12:00:00Z' },
    ],
  });
  const restored = parseScheduleWindowV1(JSON.parse(JSON.stringify(window)));
  expect(deriveScheduleNeighborhood(restored, document.matchId)).toMatchObject({
    previous: null,
    current: { isTest: true },
    next: null,
    upcoming: [],
  });
  expect(deriveScheduleNeighborhood(restored, 'official-before').next?.matchId).toBe(
    'official-after',
  );
  expect(deriveScheduleNeighborhood(restored, 'official-after').previous?.matchId).toBe(
    'official-before',
  );
});

it('uses viewing URL rules at both manifest and document boundaries and sanitizes conversion failures', async () => {
  const { toMatchDocumentV1, validateBroadcastManifest, BroadcastManifestConversionError } =
    await import('../src/index.js');
  const fixture = await readJson<BroadcastManifest>('broadcast-manifest-v1.valid.json');
  for (const url of ['http://video.example/live?a=1', 'https://video.example/live', null]) {
    const candidate = structuredClone(fixture) as Mutable<BroadcastManifest>;
    candidate.commentators[0]!.liveStreamUrl = url;
    expect(validateBroadcastManifest(candidate).ok).toBe(true);
    expect(toMatchDocumentV1(candidate).commentators[0]!.liveStreamUrl).toBe(url);
  }
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,secret',
    '//video.example/live',
    '/live',
    'http://user:secret@video.example/live',
    'https://video.example/\\evil',
    ' https://video.example/live',
  ]) {
    const candidate = structuredClone(fixture) as Mutable<BroadcastManifest>;
    candidate.commentators[0]!.liveStreamUrl = url;
    expect(validateBroadcastManifest(candidate).ok).toBe(false);
  }
  const candidate = structuredClone(fixture) as Mutable<BroadcastManifest>;
  candidate.commentators[0]!.avatarUrl = 'http://user:private@video.example/avatar';
  try {
    toMatchDocumentV1(candidate);
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(BroadcastManifestConversionError);
    expect(error).toMatchObject({
      stage: 'match_document',
      diagnostics: [expect.objectContaining({ path: 'commentators.0.avatarUrl' })],
    });
    expect(JSON.stringify(error)).not.toContain('private');
  }
});
