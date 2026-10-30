import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { avatarUrl, matchTeamIds, parseMatch } from '../src/context.js';
import { createLhmProjection } from '../src/projection.js';

it('uses the host match, media and reverse-side flag without rewriting the telemetry cursor', () => {
  const raw = JSON.parse(
    readFileSync(
      new URL('../../../fixtures/gsi/semantic/warmup/observer/frames.jsonl', import.meta.url),
      'utf8',
    ).split('\n')[0]!,
  ) as { payload: unknown };
  const match = {
    id: 'match',
    current: true,
    matchType: 'bo3',
    left: { id: 'a', wins: 1 },
    right: { id: 'b', wins: 0 },
    vetos: [
      { mapName: 'de_ancient', type: 'pick', teamId: 'a', reverseSide: false, mapEnd: false },
    ],
  };
  const a = { _id: 'a', name: 'Alpha', logo: 'present' };
  const b = { _id: 'b', name: 'Beta', logo: 'present' };
  expect(matchTeamIds(match)).toEqual(['a', 'b']);
  expect(parseMatch({ ...match, matchType: 'bo2' }, a, b)).toBeNull();
  expect(parseMatch(match, { ...a, _id: 'different' }, b)).toBeNull();
  const parsed = parseMatch(match, a, b);
  expect(parsed).not.toBeNull();
  const project = createLhmProjection();
  const initial = project(raw.payload, 100)!;
  const first = initial.program.payload.players[0]!;
  project.setMetadata(
    parsed,
    new Map([[first.sourcePlayerId, 'https://media.example/avatar.jpg']]),
  );
  const next = project.refresh(200)!;
  expect(next.program.cursor).toEqual(initial.program.cursor);
  expect(next.program.payload.series?.score).toEqual({ a: 1, b: 0 });
  expect(next.program.payload.series?.entrants.a.logoUrl).toBe('/api/teams/logo/a');
  expect(
    next.program.payload.players.find((player) => player.sourcePlayerId === first.sourcePlayerId)
      ?.avatarUrl,
  ).toBe('https://media.example/avatar.jpg');
  expect(next.program.payload.teams.ct.mode).toBe('canonical');
  const switched = parseMatch(
    { ...match, vetos: [{ ...match.vetos[0], reverseSide: true }] },
    a,
    b,
  );
  project.setMetadata(switched, new Map());
  const after = project.refresh(300)!;
  expect(after.program.payload.teams.ct).toEqual(next.program.payload.teams.t);
  project.setMetadata(null, new Map());
  expect(project.refresh(400)?.program.payload.series).toBeNull();
  expect(
    avatarUrl({ custom: 'javascript:alert(1)', steam: '/avatar.png' }, 'http://localhost:1349'),
  ).toBe('http://localhost:1349/avatar.png');
  expect(avatarUrl({ custom: '' }, 'http://localhost:1349')).toBeNull();
});
