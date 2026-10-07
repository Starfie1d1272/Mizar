import { createSeriesProgress } from '@mizar/core/series-progress';
import { projectSeries } from '@mizar/core/projection';
import { parseMatchDocumentV1 } from '@mizar/protocol/context';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toMatchContext, toMatchDocumentV1, validateBroadcastManifest } from '../src/index.js';

const resultValidation = validateBroadcastManifest(
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/independent-result-v2.json'),
      'utf8',
    ),
  ),
);
if (!resultValidation.ok) throw new Error('Invalid shared terminal-result fixture');
const resultFixture = resultValidation.value;

function independentFixture() {
  const parsed = validateBroadcastManifest(
    JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'packages/rivalhub/test/fixtures/rivalhub-provider-manifest-v1.json',
        ),
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
      resultDisposition: null,
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
  return fixture;
}

describe('independent match context', () => {
  it('converts a match without an event or declared players', () => {
    const fixture = independentFixture();
    const result = validateBroadcastManifest(fixture);
    expect(result.ok).toBe(true);
    const context = toMatchContext(fixture);
    expect(context.competition).toBeNull();
    expect(context.stage).toBeNull();
    expect(context.entrants.a.players).toEqual([]);
    expect(context.entrants.b.players).toEqual([]);
    expect(toMatchDocumentV1(fixture).competition).toBeNull();
  });
  it('keeps missing roster data informational and does not invent players', () => {
    const result = validateBroadcastManifest(independentFixture());
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.code === 'incomplete_roster')).toHaveLength(2);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });
  it('does not silently weaken the old event-only wire contract', () => {
    const fixture = independentFixture();
    fixture.schemaVersion = 'rivalhub.broadcast-manifest.v1';
    expect(validateBroadcastManifest(fixture).ok).toBe(false);
  });
  it('still rejects a BP reference to an unrelated side', () => {
    const fixture = independentFixture();
    fixture.veto = fixture.veto.map((step, index) =>
      index === 0 ? { ...step, entryId: 'unrelated' } : step,
    );
    expect(validateBroadcastManifest(fixture).ok).toBe(false);
  });
});

describe('RivalHub terminal result contract', () => {
  it.each(['recorded', 'pending', 'omitted'] as const)(
    'preserves %s through storage and projection without inventing maps',
    (resultDisposition) => {
      const recorded = resultDisposition === 'recorded';
      const fixture = {
        ...resultFixture,
        match: {
          ...resultFixture.match,
          resultDisposition,
          scoreA: recorded ? 2 : null,
          scoreB: recorded ? 1 : null,
        },
      };
      const document = parseMatchDocumentV1(JSON.parse(JSON.stringify(toMatchDocumentV1(fixture))));
      expect(document.resultDisposition).toBe(resultDisposition);
      const observed = createSeriesProgress(document);
      expect(observed.score).toEqual({ a: 0, b: 0 });
      const projected = projectSeries(document, observed);
      expect(projected).toMatchObject({
        status: 'completed',
        resultDisposition,
        score: { a: recorded ? 2 : null, b: recorded ? 1 : null },
        maps: [],
      });
      expect(projectSeries(document, null)).toEqual(projected);
    },
  );
  it('keeps stale non-terminal aggregate scores out of the live map counter', () => {
    const context = toMatchContext({
      ...resultFixture,
      match: {
        ...resultFixture.match,
        status: 'in_progress',
        completedAt: null,
        resultDisposition: null,
      },
    });
    expect(projectSeries(context, createSeriesProgress(context))?.score).toEqual({ a: 0, b: 0 });
  });
  it('rejects conflicting declared and map results', () => {
    const fixture = {
      ...resultFixture,
      match: { ...resultFixture.match, scoreA: 0, scoreB: 2 },
      maps: [
        {
          mapId: 'map',
          mapOrder: 1,
          mapName: 'de_mirage',
          pickedByEntryId: null,
          teamAStartSide: null,
          scoreA: 13,
          scoreB: 5,
          completedAt: resultFixture.match.completedAt,
        },
      ],
    };
    expect(validateBroadcastManifest(fixture).ok).toBe(false);
  });
});

it('retains unknown earlier maps when late evidence arrives out of order', () => {
  const context = toMatchContext({
    ...resultFixture,
    maps: [1, 2, 3].map((mapOrder) => ({
      mapId: `map-${mapOrder}`,
      mapOrder,
      mapName: ['de_mirage', 'de_nuke', 'de_inferno'][mapOrder - 1],
      pickedByEntryId: null,
      teamAStartSide: null,
      scoreA: mapOrder === 2 ? null : 13,
      scoreB: mapOrder === 2 ? null : 7,
      completedAt: mapOrder === 2 ? null : resultFixture.match.completedAt,
    })),
  });
  const progress = createSeriesProgress(context);
  expect(progress.maps[1]?.status).toBe('pending');
  expect(projectSeries(context, progress)?.score).toEqual({ a: 2, b: 1 });
});

it('rejects one-sided map scores in directly imported local documents', () => {
  const document = toMatchDocumentV1(independentFixture());
  expect(() =>
    parseMatchDocumentV1({
      ...document,
      maps: [{ ...document.maps[0], scoreA: 13, scoreB: null }],
    }),
  ).toThrow();
});

it('validates terminal v1 aggregate scores and evidence with the same result rules', () => {
  const parsed = validateBroadcastManifest(
    JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'packages/rivalhub/test/fixtures/rivalhub-provider-manifest-v1.json',
        ),
        'utf8',
      ),
    ),
  );
  if (!parsed.ok) throw new Error('Invalid provider fixture');
  const event = {
    ...parsed.value,
    match: { ...parsed.value.match, status: 'finished', format: 'bo3', scoreA: 1, scoreB: 1 },
    maps: [...parsed.value.maps],
  };
  expect(validateBroadcastManifest(event).ok).toBe(false);
  event.match.scoreA = 0;
  event.match.scoreB = 2;
  event.maps = [{ ...event.maps[0]!, scoreA: 13, scoreB: 7 }];
  expect(validateBroadcastManifest(event).ok).toBe(false);
  event.match.scoreA = 2;
  event.match.scoreB = 0;
  expect(validateBroadcastManifest(event).ok).toBe(true);
});
