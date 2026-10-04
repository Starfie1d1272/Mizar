import type { HudWidgetRendererProps } from '../../hud-renderer-registry';

import { buildMatchHeaderPresentation, type MatchHeaderRoundPresentation } from './presentation';
import { FreezeRoundHistory } from './FreezeRoundHistory';
import './round-history.css';

/** Clean-room renderer. It consumes #48's entrant-oriented series.roundHistory only. */

function markerClass(entrant: 'a' | 'b', round: MatchHeaderRoundPresentation): string {
  if (round.state === 'missing') return 'is-missing';
  if (round.winner === 'unknown') return 'is-unknown';
  if (round.winner !== entrant) return 'is-empty';
  if (round.winnerSide === 'CT') return 'is-ct';
  if (round.winnerSide === 'T') return 'is-t';
  return 'is-unknown';
}

// The fixed 560px widget leaves 368px for each track after its border, padding,
// labels, and entrant-name column. Density is computed against that contract.
const ROUND_HISTORY_TRACK_WIDTH = 368;

function roundHistoryDensity(roundCount: number): {
  readonly gap: number;
  readonly marker: number;
} {
  const preferredGap = roundCount >= 36 ? 1 : roundCount >= 30 ? 2 : 3;
  const marker = Math.max(
    2,
    Math.min(
      10,
      Math.floor(
        (ROUND_HISTORY_TRACK_WIDTH - preferredGap * Math.max(roundCount - 1, 0)) / roundCount,
      ),
    ),
  );
  const gap =
    marker * roundCount + preferredGap * Math.max(roundCount - 1, 0) <= ROUND_HISTORY_TRACK_WIDTH
      ? preferredGap
      : Math.max(
          0,
          Math.floor(
            (ROUND_HISTORY_TRACK_WIDTH - marker * roundCount) / Math.max(roundCount - 1, 1),
          ),
        );
  return { gap, marker };
}

export function RoundHistory(props: HudWidgetRendererProps) {
  const { snapshot, design = 'current' } = props;
  if (design !== 'current') return <FreezeRoundHistory {...props} />;
  const presentation = buildMatchHeaderPresentation(snapshot.payload);
  const history = presentation.roundHistory;
  if (history === null) return null;

  const columns = `repeat(${Math.max(history.rounds.length, 1)}, minmax(0, 1fr))`;
  const density = roundHistoryDensity(history.rounds.length);
  return (
    <section
      aria-label="回合历史"
      className="match-header match-header__round-history"
      data-completeness={history.completeness}
      data-match-header-widget="round-history"
    >
      <div className="match-header__round-history-labels" aria-hidden="true">
        <span>A</span>
        <span>B</span>
      </div>
      <div className="match-header__round-history-names" aria-hidden="true">
        <span title={presentation.teamA.name}>{presentation.teamA.name}</span>
        <span title={presentation.teamB.name}>{presentation.teamB.name}</span>
      </div>
      <div className="match-header__round-history-tracks">
        {(['a', 'b'] as const).map((entrant) => (
          <div
            className="match-header__round-history-track"
            data-entrant={entrant}
            key={entrant}
            style={{ gridTemplateColumns: columns, gap: `${density.gap}px` }}
          >
            {history.rounds.map((round) => (
              <span
                aria-label={`第 ${round.roundNumber} 回合`}
                className={`match-header__round-marker ${markerClass(entrant, round)}`}
                data-round-number={round.roundNumber}
                data-round-state={round.state}
                data-winner={round.winner}
                data-winner-side={round.winnerSide}
                key={`${entrant}-${round.roundNumber}`}
                style={{ height: density.marker, width: density.marker }}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
