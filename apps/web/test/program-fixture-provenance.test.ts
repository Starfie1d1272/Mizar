import { describe, expect, it } from 'vitest';
import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import {
  HUD_EDITOR_FIXTURE_GROUPS,
  programFixtures,
  PROGRAM_FIXTURE_PROVENANCE,
  getProgramFixtureProvenance,
} from '../src/program/fixtures';
import {
  realProgramFixtures,
  parseRealProgramArtifact,
} from '../src/program/fixtures/real-program-fixtures';
import { eplProgramFixtures } from '../src/program/fixtures/epl-program-fixtures';
import {
  derivePresentationStressFixture,
  type PresentationStressPatch,
} from '../src/program/fixtures/presentation-stress';

function gameplay(snapshot: ProgramSnapshot) {
  const p = snapshot.payload;
  return {
    ...snapshot,
    payload: {
      ...p,
      match: undefined,
      series: undefined,
      teams: {
        ct: { mode: p.teams.ct.mode, entryId: p.teams.ct.entryId },
        t: { mode: p.teams.t.mode, entryId: p.teams.t.entryId },
      },
      players: p.players.map(({ displayName, avatarUrl, ...player }) => {
        void displayName;
        void avatarUrl;
        return player;
      }),
    },
  };
}

describe('Program fixture provenance policy', () => {
  it('requires provenance on every fixture and keeps real fixtures owned by the artifact', () => {
    expect(Object.keys(PROGRAM_FIXTURE_PROVENANCE).sort()).toEqual(
      Object.keys(programFixtures).sort(),
    );
    for (const [id, snapshot] of Object.entries(programFixtures)) {
      const provenance = getProgramFixtureProvenance(id)!;
      expect(programSnapshotSchema.safeParse(snapshot).success, id).toBe(true);
      if (provenance.kind === 'real-derived') {
        expect(
          [...Object.values(realProgramFixtures), ...Object.values(eplProgramFixtures)].some(
            (record) => record.snapshot === snapshot && record.provenance === provenance,
          ),
          id,
        ).toBe(true);
      } else {
        expect(provenance.reason.trim().length, id).toBeGreaterThan(0);
        if (provenance.kind === 'synthetic-presentation') {
          expect(
            [...Object.values(realProgramFixtures), ...Object.values(eplProgramFixtures)].some(
              (record) =>
                JSON.stringify(gameplay(record.snapshot)) === JSON.stringify(gameplay(snapshot)),
            ),
            id,
          ).toBe(true);
        }
      }
    }
    for (const id of ['live-canonical', 'bomb-planted', 'bomb-defusing', 'timeout-ct'])
      expect(getProgramFixtureProvenance(id)?.kind).toBe('real-derived');
    expect(getProgramFixtureProvenance('unknown')).toBeNull();
  });

  it('keeps the operator preview limited to real replay and declared BP or media boundaries', () => {
    const ids = HUD_EDITOR_FIXTURE_GROUPS.flatMap((group) => group.ids);
    expect(ids).toEqual(
      expect.arrayContaining([
        'epl-live',
        'epl-halftime',
        'epl-map-result',
        'epl-match-result',
        'awaiting-neutral',
      ]),
    );
    expect(ids.every((id) => id.startsWith('epl-') || id === 'awaiting-neutral')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      HUD_EDITOR_FIXTURE_GROUPS[0]?.ids.every(
        (id) => getProgramFixtureProvenance(id)?.kind === 'real-derived',
      ),
    ).toBe(true);
    expect(
      HUD_EDITOR_FIXTURE_GROUPS[1]?.ids.every(
        (id) => getProgramFixtureProvenance(id)?.kind === 'synthetic-presentation',
      ),
    ).toBe(true);
  });

  it('rejects gameplay patches, including nested series injection, without changing the base', () => {
    const base = realProgramFixtures['real-live-rich'].snapshot;
    const before = JSON.stringify(base);
    for (const field of [
      'side',
      'lifeState',
      'health',
      'armor',
      'money',
      'weapons',
      'bomb',
      'clock',
      'round',
      'map',
      'status',
      'cursor',
      'liveAdr',
      'currentRoundDamage',
      'players',
    ]) {
      expect(() => derivePresentationStressFixture(base, { [field]: null }), field).toThrow();
    }
    expect(() =>
      derivePresentationStressFixture(base, {
        series: { ...base.payload.series, roundHistory: null },
      } as unknown as PresentationStressPatch),
    ).toThrow();
    const overlay = derivePresentationStressFixture(base, {
      teamAName: 'A very long entrant label',
      playerNames: { [base.payload.players[0]!.sourcePlayerId]: 'Long player label' },
    });
    expect(gameplay(overlay)).toEqual(gameplay(base));
    expect(JSON.stringify(base)).toBe(before);
  });

  it('rejects malformed artifact metadata and snapshots', () => {
    for (const value of [
      null,
      { schemaVersion: 2, fixtures: {} },
      { schemaVersion: 1, fixtures: { 'real-bad': { provenance: {}, snapshot: {} } } },
    ]) {
      expect(() => parseRealProgramArtifact(value)).toThrow();
    }
  });
});
