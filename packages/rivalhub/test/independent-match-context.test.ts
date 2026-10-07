import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toMatchContext, toMatchDocumentV1, validateBroadcastManifest } from '../src/index.js';

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
