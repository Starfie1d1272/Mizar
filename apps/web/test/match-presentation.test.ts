import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { matchMaps, matchRound, sideChoice } from '../src/preparation/match-presentation';

const fixture = JSON.parse(
  readFileSync('fixtures/rivals-rehearsal/rivals-rehearsal.generated.json', 'utf8'),
) as {
  focusMatchId: string;
  manifests: Record<
    string,
    {
      match: Pick<MatchDocumentV1, 'round' | 'roundLabel' | 'entryRound'>;
      entrants: MatchDocumentV1['entrants'];
      maps: MatchDocumentV1['maps'];
      veto: MatchDocumentV1['veto'];
    }
  >;
};
const manifest = fixture.manifests[fixture.focusMatchId]!;
// The website snapshot encodes lowercase sides; UI documents use uppercase sides.
const normalizeSide = (side: 'T' | 'CT' | null) =>
  side === null ? null : (side.toUpperCase() as 'T' | 'CT');
const document = {
  ...manifest.match,
  entrants: manifest.entrants,
  maps: manifest.maps.map((map) => ({ ...map, teamAStartSide: normalizeSide(map.teamAStartSide) })),
  veto: manifest.veto.map((step) => ({ ...step, side: normalizeSide(step.side) })),
};

describe('match presentation with the published Rivals snapshot', () => {
  it('uses available round facts without inventing a round or stakes', () => {
    expect(matchRound(document)).toBeNull();
    expect(matchRound({ ...document, round: 3 })).toBe('第 3 轮');
    expect(matchRound({ ...document, entryRound: '半决赛' })).toBe('半决赛');
    expect(matchRound({ ...document, roundLabel: '决赛', round: 3 })).toBe('决赛');
  });
  it('attributes a legacy pick side to the opponent, matching the website', () => {
    const pick = document.veto.find((s) => s.actionType === 'pick')!;
    const chooser = sideChoice(document, pick)!;
    expect(chooser.name).toBe("Team D'avenir");
    expect(chooser.side).toBe('T');
    expect(chooser.name).not.toBe(
      Object.values(document.entrants).find((t) => t.entryId === pick.entryId)?.name,
    );
    expect(sideChoice(document, { ...pick, actionType: 'side_pick' })?.name).toBe('暴躁南梁');
    expect(sideChoice(document, { ...pick, actionType: 'decider', entryId: null })).toBeNull();
  });
  it('flags contradictory start sides rather than presenting a false resolved side', () => {
    const map = matchMaps(document).find((m) => m.name === 'de_dust2')!;
    expect(map.conflict).toBe(true);
    expect(map.startA).toBeNull();
    expect(map.score).toBe('8 : 13');
  });
  it('derives both teams only from consistent evidence and keeps an unplayed decider', () => {
    const map = document.maps[0]!;
    const source = {
      ...document,
      maps: [{ ...map, teamAStartSide: null, scoreA: null, scoreB: null }],
    };
    const result = matchMaps(source);
    expect(result).toHaveLength(3);
    expect(result[0]?.startA).toBe('T');
    expect(result[0]?.startB).toBe('CT');
    expect(result[0]?.score).toBeNull();
    expect(result[2]?.selection).toBe('决胜图');
    expect(result[2]?.startA).toBeNull();
  });
});
