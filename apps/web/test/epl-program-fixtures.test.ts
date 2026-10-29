import { buildMatchHeaderPresentation } from '@mizar/hud-view';
import { describe, expect, it } from 'vitest';
import {
  HUD_EDITOR_DEFAULT_FIXTURE_ID,
  HUD_EDITOR_FIXTURE_GROUPS,
  getHudEditorFixture,
} from '../src/program/fixtures/program-fixtures.js';
import { radarSnapshotForProgramFixture } from '../src/program/fixtures/radar-fixtures.js';

describe('EPL editor samples', () => {
  it('keeps real match identity, media and atomic radar in every default sample', () => {
    expect(HUD_EDITOR_DEFAULT_FIXTURE_ID).toBe('epl-live');
    for (const id of HUD_EDITOR_FIXTURE_GROUPS[0].ids) {
      const program = getHudEditorFixture(id)!;
      const radar = radarSnapshotForProgramFixture(id)!;
      expect(program.payload.match?.matchId).toBe('hltv-2398745');
      expect(program.payload.series?.bindingState).toBe('bound');
      expect(program.payload.players).toHaveLength(10);
      expect(
        program.payload.players.every((p) => p.avatarUrl?.startsWith('/fixture-media/epl-s24/')),
      ).toBe(true);
      expect(
        Object.values(program.payload.series!.entrants).every((team) =>
          team.logoUrl?.startsWith('/fixture-media/epl-s24/'),
        ),
      ).toBe(true);
      expect(radar.cursor).toEqual(program.cursor);
      expect(program.payload.series?.maps.map((map) => map.mapName)).toEqual([
        'de_inferno',
        'de_anubis',
        'de_mirage',
      ]);
    }
  });
});

it('keeps HUD map names without inventing picker or starting side when only map order is known', () => {
  const snapshot = structuredClone(getHudEditorFixture('epl-live')!);
  const series = snapshot.payload.series!;
  for (const map of series.maps) {
    map.selection = { kind: 'unknown' };
    map.teamAStartSide = null;
  }
  const maps = buildMatchHeaderPresentation(snapshot.payload).seriesMaps!;
  expect(maps.map((map) => map.mapKey)).toEqual(['de_inferno', 'de_anubis', 'de_mirage']);
  expect(
    maps.every(
      (map) => map.picker === null && map.pickerStartSide === null && map.selectionText === '',
    ),
  ).toBe(true);
});
