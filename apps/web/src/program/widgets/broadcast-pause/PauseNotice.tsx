import { useBalancedTeamNames } from '../match-header/useBalancedTeamNames';
import type { MatchHeaderPresentation } from '../match-header/presentation';

export function PauseNotice({ presentation }: { readonly presentation: MatchHeaderPresentation }) {
  const timeout = presentation.timeoutPanel;
  const owner = timeout?.owner ?? null;
  const physicalSide = owner === 'a' ? 'left' : owner === 'b' ? 'right' : 'center';
  const team = owner === 'a' ? presentation.teamA : owner === 'b' ? presentation.teamB : null;
  const nameContainer = useBalancedTeamNames<HTMLElement>(
    team?.name ?? '',
    'pause',
    '.broadcast-pause__owner-name',
  );
  return (
    <section
      ref={nameContainer}
      className="broadcast-pause__notice"
      data-pause-info-side={physicalSide}
      data-side={team?.side ?? 'unknown'}
      aria-label={timeout ? 'Tactical timeout' : 'Technical pause'}
    >
      <header>
        <strong data-pause-header-part="label">{timeout ? 'TIMEOUT' : 'TECH PAUSE'}</strong>
        <span
          data-pause-header-part="team"
          className="broadcast-pause__owner-name"
          title={team?.name}
        >
          {team?.name ?? ''}
        </span>
      </header>
      {timeout ? (
        <div className="broadcast-pause__countdown">
          <strong data-pause-countdown-part="clock">{timeout.clockText ?? '—'}</strong>
          <span data-pause-countdown-part="remaining" className="broadcast-pause__remaining-number">
            <b>{timeout.remaining ?? '—'}</b> REMAINING
          </span>
        </div>
      ) : (
        <div className="broadcast-pause__technical">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M5 3h5v18H5zM14 3h5v18h-5z" />
          </svg>
          <span>WAITING TO RESUME</span>
        </div>
      )}
    </section>
  );
}
