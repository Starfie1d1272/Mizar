import type { CSSProperties } from 'react';
import { assetForCanonicalKey } from '../player-rails/presentation';
import type {
  MatchHeaderRoundHistoryPresentation,
  MatchHeaderRoundPresentation,
} from './presentation';
import { ROUND_HISTORY_LABELS, roundHistorySegment } from './round-history-presentation';

function WinIcon({
  condition,
}: {
  readonly condition: MatchHeaderRoundPresentation['winCondition'];
}) {
  if (condition === 'defuse') {
    const asset = assetForCanonicalKey('equipment.defuse-kit');
    return asset ? (
      <span
        className="round-history-panel__kit"
        style={{ '--history-icon': `url("${asset.outputPath}")` } as CSSProperties}
      />
    ) : (
      <span>?</span>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {condition === 'elimination' ? (
        <path
          fillRule="evenodd"
          d="M12 2a8 8 0 0 0-8 8v4l3 3v4h3v-3h1v3h2v-3h1v3h3v-4l3-3v-4a8 8 0 0 0-8-8ZM7 10a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm6 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm-1 3-2 3h4Z"
        />
      ) : condition === 'bomb' ? (
        <path d="m12 2 2.3 5.5 5.5-2.3-2.3 5.5L23 13l-5.5 2.3 2.3 5.5-5.5-2.3L12 24l-2.3-5.5-5.5 2.3 2.3-5.5L1 13l5.5-2.3-2.3-5.5 5.5 2.3z" />
      ) : condition === 'time' ? (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 6v6l4 2" fill="none" stroke="currentColor" strokeWidth="2" />
        </>
      ) : (
        <path
          d="M9 8a3 3 0 1 1 5 2c-1.3 1-2 1.5-2 3M12 16v2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      )}
    </svg>
  );
}

export function RoundHistoryPanel({
  history,
  mode,
}: {
  readonly history: MatchHeaderRoundHistoryPresentation;
  readonly mode: 'freeze' | 'pause';
}) {
  const segment = roundHistorySegment(history);
  return (
    <section
      className="round-history-panel"
      data-history-mode={mode}
      data-completeness={history.completeness}
      aria-label="Round history"
    >
      <header>
        <strong>{segment.label}</strong>
        <span>ROUND HISTORY</span>
      </header>
      <div className="round-history-panel__rounds">
        {segment.slots.map(({ roundNumber, result }) => {
          const known = result?.state === 'known';
          const side = known ? result.winnerSide : 'unknown';
          const reason = known ? ROUND_HISTORY_LABELS[result.winCondition] : 'UNAVAILABLE';
          return (
            <div
              className="round-history-panel__round"
              data-round-number={roundNumber}
              data-winner-side={side}
              data-round-state={result?.state ?? 'pending'}
              data-win-condition={known ? result.winCondition : 'unknown'}
              aria-label={`ROUND ${roundNumber} · ${known ? side : 'UNKNOWN'} · ${reason}`}
              title={`ROUND ${roundNumber} · ${reason}`}
              key={roundNumber}
            >
              <span>{roundNumber}</span>
              {known ? (
                <WinIcon condition={result.winCondition} />
              ) : (
                <span className="round-history-panel__empty" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
