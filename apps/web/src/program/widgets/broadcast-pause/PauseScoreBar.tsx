import type { TopScoreBarSettings } from '@mizar/hud-config';
import { useBalancedTeamNames } from '../match-header/useBalancedTeamNames';
import {
  formatMatchHeaderScore,
  type MatchHeaderPresentation,
  type MatchHeaderTeamPresentation,
} from '../match-header/presentation';
import type { PlayerRailPresentation, PlayerRailsPresentation } from '../player-rails/presentation';
import { TimeoutSlots } from './TimeoutSlots';

function Money({ value }: { readonly value: number | null }) {
  return <strong>{value === null ? '—' : `$${Math.round(value).toLocaleString('en-US')}`}</strong>;
}

function Economy({
  rail,
  team,
  visible,
  physicalSide,
  roundNumber,
}: {
  readonly rail: PlayerRailPresentation;
  readonly team: MatchHeaderTeamPresentation;
  readonly visible: boolean;
  readonly physicalSide: 'left' | 'right';
  readonly roundNumber: number | null;
}) {
  return (
    <div
      className="broadcast-pause__economy"
      data-physical-side={physicalSide}
      data-side={rail.side}
    >
      {visible ? (
        <>
          <div data-economy-field="equipment">
            <span>EQUIPMENT VALUE</span>
            <Money value={rail.summary.equip} />
          </div>
          <div data-economy-field="loss">
            <span>LOSS BONUS</span>
            <Money value={rail.summary.lossBonus} />
          </div>
          <div data-economy-field="timeouts">
            <span>TIMEOUTS REMAINING</span>
            <TimeoutSlots remaining={team.timeoutsRemaining} roundNumber={roundNumber} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function TeamLogo({
  team,
  visible,
  physicalSide,
}: {
  readonly team: MatchHeaderTeamPresentation;
  readonly visible: boolean;
  readonly physicalSide: 'left' | 'right';
}) {
  return (
    <div
      data-physical-side={physicalSide}
      className="broadcast-pause__team-logo"
      data-side={team.side ?? 'unknown'}
    >
      {visible && team.logoUrl ? (
        <img
          src={team.logoUrl}
          alt=""
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      ) : null}
    </div>
  );
}

function TeamName({
  team,
  showSeriesWins,
}: {
  readonly team: MatchHeaderTeamPresentation;
  readonly showSeriesWins: boolean;
}) {
  return (
    <div className="broadcast-pause__team-identity">
      <strong className="broadcast-pause__team-name" title={team.name}>
        {team.name}
      </strong>
      {showSeriesWins && team.winSlots ? (
        <div className="broadcast-pause__series-wins" aria-label={`${team.name} series wins`}>
          {team.winSlots.map((won, index) => (
            <i data-series-win-slot={won ? 'won' : 'pending'} key={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PauseScoreBar({
  presentation: p,
  rails,
  options,
  roundNumber,
  leftSummaryVisible,
  rightSummaryVisible,
}: {
  readonly presentation: MatchHeaderPresentation;
  readonly rails: PlayerRailsPresentation;
  readonly options: TopScoreBarSettings;
  readonly roundNumber: number | null;
  readonly leftSummaryVisible: boolean;
  readonly rightSummaryVisible: boolean;
}) {
  const nameContainer = useBalancedTeamNames<HTMLDivElement>(
    `${p.teamA.name}:${p.teamB.name}`,
    'pause',
    '.broadcast-pause__team-name',
    44,
  );
  return (
    <div className="broadcast-pause__bar">
      <Economy
        rail={rails.left}
        team={p.teamA}
        physicalSide="left"
        roundNumber={roundNumber}
        visible={leftSummaryVisible}
      />
      <div className="broadcast-pause__score" ref={nameContainer}>
        <TeamLogo physicalSide="left" team={p.teamA} visible={options.showTeamLogo} />
        <TeamName team={p.teamA} showSeriesWins={options.showSeriesWins} />
        <b>{formatMatchHeaderScore(p.teamA.mapScore)}</b>
        <span>VS</span>
        <b>{formatMatchHeaderScore(p.teamB.mapScore)}</b>
        <TeamName team={p.teamB} showSeriesWins={options.showSeriesWins} />
        <TeamLogo physicalSide="right" team={p.teamB} visible={options.showTeamLogo} />
      </div>
      <Economy
        rail={rails.right}
        team={p.teamB}
        physicalSide="right"
        roundNumber={roundNumber}
        visible={rightSummaryVisible}
      />
    </div>
  );
}
