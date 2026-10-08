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

  it('uses witnessed objective and side-switch states without completed future maps', () => {
    expect(getHudEditorFixture('epl-defusing')?.payload.bomb?.state).toBe('defusing');
    expect(getHudEditorFixture('epl-timeout')?.payload.clock?.phase).toBe('timeout_ct');
    expect(getHudEditorFixture('epl-halftime')?.payload.teams.ct.entryId).toBe('epl-navi');
    const result = getHudEditorFixture('epl-map-result')!.payload;
    expect(result.map.score).toEqual({ ct: 6, t: 13 });
    expect(result.series?.maps.slice(1).every((map) => map.finalScore === null)).toBe(true);
  });
});
