import { describe, expect, it } from 'vitest';

import { getProgramFixture } from '../src/program/fixtures';
import {
  buildMatchHeaderPresentation,
  displayRoundNumber,
  formatMatchHeaderScore,
} from '../src/program/widgets/match-header/presentation';

function presentation(fixtureId: string) {
  const snapshot = getProgramFixture(fixtureId);
  if (snapshot === null) throw new Error(`fixture missing: ${fixtureId}`);
  return buildMatchHeaderPresentation(snapshot.payload);
}

describe('Match Header presentation selector', () => {
  it.each([
    { count: 0, phase: 'freezetime', mapPhase: 'live', ct: 0, t: 0, expected: 1 },
    { count: 3, phase: 'freezetime', mapPhase: 'live', ct: 0, t: 3, expected: 4 },
    { count: 3, phase: 'live', mapPhase: 'live', ct: 0, t: 3, expected: 4 },
    { count: 3, phase: 'over', mapPhase: 'live', ct: 1, t: 3, expected: 4 },
    { count: 4, phase: 'over', mapPhase: 'live', ct: 1, t: 3, expected: 4 },
    { count: 19, phase: 'over', mapPhase: 'gameover', ct: 6, t: 13, expected: 19 },
    { count: 24, phase: 'live', mapPhase: 'live', ct: 12, t: 12, expected: 25 },
    { count: 0, phase: 'freezetime', mapPhase: 'warmup', ct: 0, t: 0, expected: null },
    { count: null, phase: 'live', mapPhase: 'live', ct: 0, t: 3, expected: null },
  ] as const)('uses the same active/settled round for every HUD: %j', (sample) => {
    const base = getProgramFixture('real-live-rich')!.payload;
    const payload = {
      ...base,
      map: {
        ...base.map,
        phase: sample.mapPhase,
        roundNumber: sample.count,
        score: { ct: sample.ct, t: sample.t },
      },
      round: { phase: sample.phase, winnerSide: 'unknown' as const },
    };
    expect(displayRoundNumber(payload)).toBe(sample.expected);
    expect(buildMatchHeaderPresentation(payload)).toMatchObject({
      roundNumber: sample.expected,
      roundLabel: sample.expected === null ? null : `ROUND ${sample.expected}`,
    });
  });

  it('shows source-side history for a demo without series identity', () => {
    const base = getProgramFixture('real-live-rich')!.payload;
    const value = buildMatchHeaderPresentation({
      ...base,
      series: null,
      match: null,
      map: {
        ...base.map,
        roundHistory: {
          completeness: 'complete',
          rounds: [
            { roundNumber: 1, winnerSide: 'CT', winnerEntryId: null, winCondition: 'defuse' },
          ],
        },
      },
    });
    expect(value.roundHistory?.rounds[0]).toMatchObject({
      winner: 'unknown',
      winnerSide: 'CT',
      winCondition: 'defuse',
    });
    expect(value.teamA.name).toBe('CT');
  });
  it('maps BO3 and BO5 victory slots to stable entrant series wins', () => {
    const base = getProgramFixture('real-live-rich')!.payload;
    const p = buildMatchHeaderPresentation({
      ...base,
      series: { ...base.series!, score: { a: 1, b: 0 } },
    });
    expect(p.teamA.winSlots).toEqual([true, false]);
    expect(p.teamB.winSlots).toEqual([false, false]);
    expect(presentation('series-bo5').teamA.winSlots).toEqual([true, false, false]);
  });
  it('keeps canonical entrants left/right while joining current side facts by entryId', () => {
    const normal = presentation('live-canonical');
    expect(normal.currentSideMapping).toBe('resolved');
    expect(normal.teamA).toMatchObject({
      name: 'FURIA',
      side: 'CT',
      mapScore: 2,
      timeoutsRemaining: 1,
      seriesScore: 0,
    });
    expect(normal.teamB).toMatchObject({
      name: 'G2.Esports',
      side: 'T',
      mapScore: 0,
      timeoutsRemaining: 1,
      seriesScore: 0,
    });

    const swapped = presentation('series-halftime-swap');
    expect(swapped.teamA).toMatchObject({ name: 'FURIA', side: 'T', mapScore: 7 });
    expect(swapped.teamB).toMatchObject({ name: 'G2.Esports', side: 'CT', mapScore: 5 });
  });

  it('fails closed for side-owned facts when canonical mapping is unavailable', () => {
    const value = presentation('series-mapping-unavailable');
    expect(value.currentSideMapping).toBe('unavailable');
    expect(value.teamA).toMatchObject({ name: 'Northstar', side: null, mapScore: null });
    expect(value.teamB).toMatchObject({ name: 'Southpoint', side: null, mapScore: null });
    expect(value.timeoutPanel).toMatchObject({
      owner: null,
      ownerName: null,
      remaining: 1,
      clockText: '0:22',
    });
  });

  it('resolves timeout ownership only after the same entryId join', () => {
    const value = presentation('series-timeout-b');
    expect(value.timeoutPanel).toMatchObject({
      owner: 'b',
      ownerName: 'G2.Esports',
      remaining: 2,
      clockText: '0:30',
    });
  });

  it('covers entrant A tactical timeout facts with the canonical series', () => {
    expect(presentation('series-timeout-a').timeoutPanel).toMatchObject({
      owner: 'a',
      ownerName: 'FURIA',
      remaining: 2,
      clockText: '0:30',
    });
  });

  it('keeps objective phases free of donor countdown reconstruction', () => {
    const planted = presentation('bomb-planted');
    expect(planted.phaseLabel).toBe('PLANTED');
    expect(planted.clockText).toBeNull();

    const defusing = presentation('bomb-defusing');
    expect(defusing.phaseLabel).toBe('DEFUSING');
    expect(defusing.clockText).toBeNull();

    const paused = presentation('series-paused');
    expect(paused.phaseLabel).toBe('TECH PAUSE');
    expect(paused.clockText).toBeNull();
  });

  it('renders the frozen map status and BO5 density model from Program series truth', () => {
    const value = presentation('series-bo5');
    expect(value.bestOfLabel).toBe('BO5');
    expect(value.seriesMaps).toHaveLength(5);
    expect(value.seriesMaps?.map((map) => map.statusText)).toEqual([
      '13–11',
      '13–8',
      'PLAYING',
      'PENDING',
      'PENDING',
    ]);
    expect(value.seriesMaps?.[0]).toMatchObject({
      selectionText: 'PICK',
      winner: 'a',
      pickOutcome: 'win',
      winnerName: 'Northstar',
    });
    expect(value.seriesMaps?.[1]).toMatchObject({
      winner: 'b',
      pickOutcome: 'win',
      winnerName: 'Southpoint',
    });
    expect(value.seriesMaps?.[1]).toMatchObject({
      selectionText: 'PICK',
      picker: 'b',
      pickerStartSide: 'CT',
    });
    expect(value.seriesMaps?.[2]).toMatchObject({
      selectionText: 'PICK',
      picker: 'a',
      pickerStartSide: 'T',
    });
    expect(value.seriesMaps?.[4]).toMatchObject({
      selectionText: 'DECIDER',
      picker: null,
      pickerStartSide: null,
    });
  });

  it('marks a completed picked-map loss from the picker perspective', () => {
    const snapshot = getProgramFixture('series-bo5');
    if (snapshot === null || snapshot.payload.series === null) throw new Error('fixture missing');
    const series = snapshot.payload.series;
    const first = series.maps[0];
    if (first === undefined || first.selection.kind !== 'pick') {
      throw new Error('picked map missing');
    }
    const opposingWinner =
      first.selection.entryId === series.entrants.a.entryId
        ? series.entrants.b.entryId
        : series.entrants.a.entryId;
    const value = buildMatchHeaderPresentation({
      ...snapshot.payload,
      series: {
        ...series,
        maps: series.maps.map((map, index) =>
          index === 0 ? { ...map, winnerEntryId: opposingWinner } : map,
        ),
      },
    });

    expect(value.seriesMaps?.[0]?.pickOutcome).toBe('loss');
  });

  it('keeps the picker score on the left in the picker-loss preview', () => {
    const value = presentation('series-bo5-pick-loss');
    expect(value.seriesMaps?.[0]).toMatchObject({ statusText: '13–11', pickOutcome: 'win' });
    expect(value.seriesMaps?.[1]).toMatchObject({
      statusText: '8–13',
      pickOutcome: 'loss',
      winner: 'a',
    });
  });

  it('fails closed when a completed map has no known winner', () => {
    const snapshot = getProgramFixture('series-bo5');
    if (snapshot === null || snapshot.payload.series === null) throw new Error('fixture missing');
    const series = snapshot.payload.series;
    const value = buildMatchHeaderPresentation({
      ...snapshot.payload,
      series: {
        ...series,
        maps: series.maps.map((map, index) =>
          index === 0 ? { ...map, winnerEntryId: null } : map,
        ),
      },
    });

    expect(value.seriesMaps?.[0]).toMatchObject({
      statusText: '13–11',
      winner: null,
      pickOutcome: null,
      winnerName: null,
    });
  });

  it('covers the frozen BO3 Map 1, not-played, and logo availability fixtures', () => {
    expect(presentation('series-bo3-map1').seriesMaps?.[0]).toMatchObject({
      mapName: 'Ancient',
      status: 'current',
      selectionText: 'PICK',
    });
    expect(
      presentation('series-not-played').seriesMaps?.some((map) => map.status === 'not_played'),
    ).toBe(true);
    expect(presentation('series-logo-mixed').teamA.logoUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(presentation('series-logo-mixed').teamB.logoUrl).toBeNull();
  });

  it('does not render a production placeholder when roundNumber is unavailable', () => {
    expect(presentation('series-round-unavailable').roundLabel).toBeNull();
  });

  it('keeps dense overtime history bounded to the fixed widget model', () => {
    expect(presentation('series-overtime-history').roundHistory?.rounds).toHaveLength(36);
  });

  it('fills partial history gaps without inventing a winner and hides unavailable history', () => {
    const partial = presentation('series-partial-history');
    expect(partial.roundHistory?.completeness).toBe('partial');
    expect(partial.roundHistory?.rounds.map((round) => round.state)).toEqual([
      'missing',
      'missing',
      'known',
      'missing',
      'known',
    ]);
    expect(partial.roundHistory?.rounds[4]).toMatchObject({ winner: 'b', winnerSide: 'unknown' });
    expect(presentation('series-history-unavailable').roundHistory).toBeNull();
  });

  it('uses a neutral CT/T fallback only when there is no canonical series', () => {
    const value = presentation('live-neutral');
    expect(value.currentSideMapping).toBe('neutral');
    expect(value.teamA).toMatchObject({ name: 'CT', entryId: null, side: 'CT', mapScore: 3 });
    expect(value.teamB).toMatchObject({ name: 'T', entryId: null, side: 'T', mapScore: 2 });
    expect(value.seriesMaps).toBeNull();
  });

  it('keeps fixed-width numeric fallback text explicit', () => {
    expect(formatMatchHeaderScore(null)).toBe('—');
    expect(formatMatchHeaderScore(0)).toBe('0');
  });
});

it('shows an absent terminal result without a synthetic zero score or wins', () => {
  const base = getProgramFixture('real-live-rich')!.payload;
  if (base.series === null) throw new Error('Missing fixture series');
  const value = buildMatchHeaderPresentation({
    ...base,
    series: {
      ...base.series,
      status: 'completed',
      resultDisposition: 'omitted',
      score: { a: null, b: null },
    },
  });
  expect(value.seriesScoreText).toBe('—:—');
});
