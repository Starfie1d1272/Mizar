import { describe, expect, it } from 'vitest';

import { RIVALS_BP_RECORDS, rivalsSeriesCut } from '../src/program/fixtures/rivals-bp-records';
import {
  getHudEditorFixture,
  getProgramFixture,
  getProgramFixtureReplaySource,
  HUD_EDITOR_DEFAULT_FIXTURE_ID,
  HUD_EDITOR_FIXTURE_GROUPS,
  HUD_EDITOR_RIVALS_BP_FIXTURE_IDS,
} from '../src/program/fixtures';
import { buildMatchHeaderPresentation } from '../src/program/widgets/match-header/presentation';

describe('Rivals BP preview records', () => {
  it('keeps each picked map tied to its source veto and never assigns a picker to a decider', () => {
    for (const record of Object.values(RIVALS_BP_RECORDS)) {
      expect(record.veto).toHaveLength(7);
      expect(record.entrants.a.logoUrl).toContain('/storage/v1/object/public/team-logos/');
      expect(record.entrants.b.logoUrl).toContain('/storage/v1/object/public/team-logos/');
      for (const map of record.maps) {
        const step = record.veto.find((candidate) => candidate.mapName === map.mapName);
        expect(step).toBeDefined();
        expect(step?.actionType).toBe(map.selection.kind);
        if (map.selection.kind === 'pick') {
          expect(map.selection.entryId).toBe(step?.entryId);
          expect(map.teamAStartSide).not.toBeNull();
        }
        if (map.selection.kind === 'decider') expect(map.winnerEntryId).toBeNull();
      }

      const preview = buildMatchHeaderPresentation({
        ...getProgramFixture('bp-rivals-final-result')!.payload,
        series: rivalsSeriesCut(record, null),
      });
      for (const map of preview.seriesMaps ?? []) {
        if (map.picker === null) {
          expect(map.pickerLogoUrl).toBeNull();
          continue;
        }
        expect(map.pickerLogoUrl).toBe(record.entrants[map.picker].logoUrl);
      }
    }
  });

  it('derives the final map-four cut from recorded results without revealing future scores', () => {
    const cut = rivalsSeriesCut(RIVALS_BP_RECORDS.final, 4);
    expect(cut.score).toEqual({ a: 2, b: 1 });
    expect(cut.maps.map((map) => map.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'current',
      'pending',
    ]);
    expect(cut.maps[3]?.finalScore).toBeNull();
    expect(cut.maps[4]?.teamAStartSide).toBeNull();
    const rendered = getProgramFixture('bp-rivals-final-map4');
    if (rendered === null) throw new Error('final preview missing');
    const maps = buildMatchHeaderPresentation(rendered.payload).seriesMaps;
    expect(maps?.[0]).toMatchObject({ statusText: '4–13', pickOutcome: 'loss', picker: 'b' });
    expect(maps?.[1]).toMatchObject({ statusText: '13–1', pickOutcome: 'win', picker: 'a' });
    expect(maps?.[2]).toMatchObject({ statusText: '13–9', pickOutcome: 'win', picker: 'b' });
  });

  it('keeps the recorded unplayed decider and the side choice in the other semifinal', () => {
    const final = rivalsSeriesCut(RIVALS_BP_RECORDS.final, null);
    expect(final.score).toEqual({ a: 3, b: 1 });
    expect(final.maps[4]).toMatchObject({
      status: 'not_played',
      finalScore: null,
      teamAStartSide: null,
    });
    const semi = rivalsSeriesCut(RIVALS_BP_RECORDS.semifinalA, null);
    expect(semi.score).toEqual({ a: 0, b: 2 });
    expect(semi.maps[2]).toMatchObject({ selection: { kind: 'decider' }, teamAStartSide: 'CT' });
  });

  it('keeps all three complete Rivals veto records available as HUD editor cuts', () => {
    const records = [
      ['bp-rivals-final-map4', RIVALS_BP_RECORDS.final, 4],
      ['bp-rivals-final-result', RIVALS_BP_RECORDS.final, null],
      ['bp-rivals-semi-a-result', RIVALS_BP_RECORDS.semifinalA, null],
      ['bp-rivals-semi-b-result', RIVALS_BP_RECORDS.semifinalB, null],
    ] as const;
    const editorIds = HUD_EDITOR_FIXTURE_GROUPS[1]?.ids ?? [];

    expect(editorIds).toEqual(records.map(([id]) => id));
    expect(HUD_EDITOR_DEFAULT_FIXTURE_ID).toBe('real-live-rich');
    expect(RIVALS_BP_RECORDS.final.maps).toHaveLength(5);
    expect(RIVALS_BP_RECORDS.semifinalA.maps).toHaveLength(3);
    expect(RIVALS_BP_RECORDS.semifinalB.maps).toHaveLength(3);

    for (const [id, record, currentMapOrder] of records) {
      const expected = rivalsSeriesCut(record, currentMapOrder);
      const fixture = getProgramFixture(id);
      if (fixture === null) throw new Error(`Rivals BP fixture missing: ${id}`);
      const actual = fixture.payload.series;
      expect(actual, id).not.toBeNull();
      expect(actual!.score, id).toEqual(expected.score);
      expect(
        actual!.maps.map(({ mapName, selection, teamAStartSide, status, finalScore }) => ({
          mapName,
          selection: selection.kind,
          teamAStartSide,
          status,
          finalScore,
        })),
        id,
      ).toEqual(
        expected.maps.map(({ mapName, selection, teamAStartSide, status, finalScore }) => ({
          mapName,
          selection: selection.kind,
          teamAStartSide,
          status,
          finalScore,
        })),
      );
      expect(
        actual!.veto.map(({ stepOrder, actionType, mapName, side }) => ({
          stepOrder,
          actionType,
          mapName,
          side,
        })),
        id,
      ).toEqual(
        record.veto.map(({ stepOrder, actionType, mapName, side }) => ({
          stepOrder,
          actionType,
          mapName,
          side,
        })),
      );
    }

    expect(HUD_EDITOR_RIVALS_BP_FIXTURE_IDS).toEqual(
      HUD_EDITOR_FIXTURE_GROUPS[0]?.ids.filter((id) => id !== 'gameplay-map-ended-gg'),
    );
    for (const id of HUD_EDITOR_RIVALS_BP_FIXTURE_IDS) {
      const fixture = getHudEditorFixture(id);
      if (fixture === null) throw new Error(`Rivals BP HUD preview missing: ${id}`);
      const series = fixture.payload.series;
      expect(series?.veto, id).toHaveLength(7);
      expect(series?.entrants.a.logoUrl, id).toContain('/storage/v1/object/public/team-logos/');
      expect(series?.entrants.b.logoUrl, id).toContain('/storage/v1/object/public/team-logos/');

      const header = buildMatchHeaderPresentation(fixture.payload);
      expect(header.teamA.logoUrl, id).toBe(series?.entrants.a.logoUrl);
      expect(header.teamB.logoUrl, id).toBe(series?.entrants.b.logoUrl);
      const actualVeto = series!.veto.map(({ stepOrder, actionType, mapName, side }) => ({
        stepOrder,
        actionType,
        mapName,
        side,
      }));
      expect(
        Object.values(RIVALS_BP_RECORDS).some(
          (record) =>
            JSON.stringify(actualVeto) ===
            JSON.stringify(
              record.veto.map(({ stepOrder, actionType, mapName, side }) => ({
                stepOrder,
                actionType,
                mapName,
                side,
              })),
            ),
        ),
        id,
      ).toBe(true);
      expect(getProgramFixtureReplaySource(id)?.snapshot).toBe(getProgramFixture(id));
    }

    const defaultFixture = getHudEditorFixture(HUD_EDITOR_DEFAULT_FIXTURE_ID);
    if (defaultFixture === null) throw new Error('Default HUD BP preview missing');
    const header = buildMatchHeaderPresentation(defaultFixture.payload);
    expect(header.teamA.name).toBe(RIVALS_BP_RECORDS.final.entrants.a.name);
    expect(header.teamA.logoUrl).toBe(RIVALS_BP_RECORDS.final.entrants.a.logoUrl);
    expect(header.teamB.name).toBe(RIVALS_BP_RECORDS.final.entrants.b.name);
    expect(header.teamB.logoUrl).toBe(RIVALS_BP_RECORDS.final.entrants.b.logoUrl);
  });
});
