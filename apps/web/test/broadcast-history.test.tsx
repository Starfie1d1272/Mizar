// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { getProgramFixture } from '../src/program/fixtures';
import { buildMatchHeaderPresentation } from '../src/program/widgets/match-header/presentation';
import { FreezeRoundHistory } from '../src/program/widgets/match-header/FreezeRoundHistory';
import { RoundHistoryPanel } from '../src/program/widgets/match-header/RoundHistoryPanel';
import {
  freezeHistoryEligible,
  roundHistorySegment,
} from '../src/program/widgets/match-header/round-history-presentation';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});
function history(id: string) {
  const value = buildMatchHeaderPresentation(getProgramFixture(id)!.payload).roundHistory;
  if (!value) throw new Error(`Missing history: ${id}`);
  return value;
}
function mountFreeze(snapshot: ProgramSnapshot, revision = 0, container?: HTMLDivElement) {
  const node = container ?? document.createElement('div');
  root ??= createRoot(node);
  const resolvedPreset = getBuiltinResolvedPreset('builtin:iem-preset');
  const placement = resolvedPreset.layout.widgets['round-history'];
  act(() =>
    root!.render(
      <FreezeRoundHistory
        snapshot={snapshot}
        presentationRevision={revision}
        resolvedPreset={resolvedPreset}
        widgetId="round-history"
        placement={placement}
        box={placementToBox('round-history', placement)}
        design="iem"
        settings={resolvedPreset.widgets['round-history']}
      />,
    ),
  );
  return node;
}

describe('Broadcast round history', () => {
  it('preserves the real replay reasons and historical sides without assigning current entrants', () => {
    const h = history('real-halftime-before');
    expect(new Set(h.rounds.map((r) => r.winCondition))).toEqual(
      new Set(['elimination', 'bomb', 'defuse', 'time']),
    );
    const node = document.createElement('div');
    root = createRoot(node);
    act(() => root!.render(<RoundHistoryPanel history={h} mode="pause" />));
    for (const round of h.rounds) {
      const slot = node.querySelector(`[data-round-number="${round.roundNumber}"]`)!;
      expect(slot.getAttribute('data-win-condition')).toBe(round.winCondition);
      expect(slot.getAttribute('data-winner-side')).toBe(round.winnerSide);
      expect(slot.querySelector('svg, .round-history-panel__kit')).not.toBeNull();
    }
    expect(node.querySelector('.round-history-panel__kit')?.getAttribute('style')).toContain(
      'defuse',
    );
    const base = getProgramFixture('real-halftime-before')!.payload;
    const anonymous = buildMatchHeaderPresentation({
      ...base,
      series: {
        ...base.series!,
        roundHistory: {
          ...base.series!.roundHistory!,
          rounds: base.series!.roundHistory!.rounds.map((r) => ({ ...r, winnerEntryId: null })),
        },
      },
    }).roundHistory!;
    expect(anonymous.rounds.every((r) => r.winner === 'unknown')).toBe(true);
    expect(anonymous.rounds.map((r) => r.winnerSide)).toEqual(h.rounds.map((r) => r.winnerSide));
  });
  it('uses the latest half or bounded six-round overtime segment, with neutral gaps', () => {
    expect(roundHistorySegment(history('real-halftime-before'))).toMatchObject({
      label: '1ST HALF',
    });
    expect(roundHistorySegment(history('real-overtime-entry'))).toMatchObject({
      label: '2ND HALF',
    });
    const ot = roundHistorySegment(history('series-overtime-history'));
    expect(ot.label).toBe('OT 2');
    expect(ot.slots.map((s) => s.roundNumber)).toEqual([31, 32, 33, 34, 35, 36]);
    const partial = roundHistorySegment(history('series-partial-history'));
    expect(partial.slots[0]?.result).toMatchObject({ state: 'missing', winCondition: 'unknown' });
    expect(partial.slots.at(-1)?.result).toBeNull();
  });
  it('shows only each third completed round during accepted freeze time, never in LIVE or its last three seconds', () => {
    const snapshot = getProgramFixture('real-post-explosion-freezetime')!;
    expect(freezeHistoryEligible(snapshot.payload)).toBe(true);
    expect(freezeHistoryEligible(getProgramFixture('real-live-rich')!.payload)).toBe(false);
    expect(
      freezeHistoryEligible({
        ...snapshot.payload,
        map: { ...snapshot.payload.map, roundNumber: 2 },
      }),
    ).toBe(false);
    expect(
      freezeHistoryEligible({
        ...snapshot.payload,
        clock: { ...snapshot.payload.clock!, endsInSeconds: 3 },
      }),
    ).toBe(false);
    expect(
      freezeHistoryEligible({
        ...snapshot.payload,
        status: { ...snapshot.payload.status, telemetry: 'stale' },
      }),
    ).toBe(false);
  });
  it('expires after five seconds without restarting on accepted packets, and resets on seek/source/map boundaries', () => {
    vi.useFakeTimers();
    const snapshot = getProgramFixture('real-post-explosion-freezetime')!;
    const node = mountFreeze(snapshot);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    mountFreeze(
      { ...snapshot, cursor: { ...snapshot.cursor, runtimeSeq: snapshot.cursor.runtimeSeq + 1 } },
      0,
      node,
    );
    expect(node.querySelector('[data-history-mode="freeze"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(node.querySelector('[data-history-mode="freeze"]')).toBeNull();
    mountFreeze(snapshot, 1, node);
    expect(node.querySelector('[data-history-mode="freeze"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    for (const cursor of [
      { ...snapshot.cursor, programSourceGeneration: snapshot.cursor.programSourceGeneration + 1 },
      { ...snapshot.cursor, mapEpoch: snapshot.cursor.mapEpoch + 1 },
    ]) {
      mountFreeze({ ...snapshot, cursor }, 1, node);
      expect(node.querySelector('[data-history-mode="freeze"]')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(node.querySelector('[data-history-mode="freeze"]')).toBeNull();
    }
    mountFreeze(
      {
        ...snapshot,
        payload: { ...snapshot.payload, clock: { ...snapshot.payload.clock!, endsInSeconds: 3 } },
      },
      2,
      node,
    );
    expect(node.querySelector('[data-history-mode="freeze"]')).toBeNull();
    mountFreeze(getProgramFixture('real-live-rich')!, 3, node);
    expect(node.querySelector('[data-history-mode="freeze"]')).toBeNull();
  });
});
