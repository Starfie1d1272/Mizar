import { topScoreBarSettingsSchema, type TopScoreBarSettings } from '@mizar/hud-config';
/** Match composition adapted from Lexogrine cs2-react-hud@7874750c97fcecd8f72eb3fad382917e035ec651
 * (MIT). Angular shell, series pips and objective choreography follow the user-provided reference.
 * Team binding and all gameplay progress remain owned by the existing presentation join/Core. */
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import { useEffect, useRef, useState } from 'react';
import { ObjectiveCenter, ObjectiveFuse } from './ObjectiveCenter';
import {
  buildMatchHeaderPresentation,
  formatMatchHeaderScore,
  type MatchHeaderTeamPresentation,
} from './presentation';

const PANEL_EXIT_MS = 160;

type PanelMotionPhase = 'enter' | 'steady' | 'exit';

/* eslint-disable react-hooks/set-state-in-effect -- Renderer-local presence state intentionally snapshots the last visible panel so its exit motion can complete. */
function usePanelPresence<T>(value: T | null, exitMs = PANEL_EXIT_MS) {
  const [rendered, setRendered] = useState<T | null>(value);
  const [phase, setPhase] = useState<PanelMotionPhase>(value === null ? 'steady' : 'enter');
  const wasPresent = useRef(value !== null);
  const firstEffect = useRef(true);

  useEffect(() => {
    if (firstEffect.current) {
      firstEffect.current = false;
      return;
    }

    if (value !== null) {
      const entering = !wasPresent.current;
      wasPresent.current = true;
      setRendered(value);
      setPhase(entering ? 'enter' : 'steady');
      return;
    }

    if (!wasPresent.current) {
      setRendered(null);
      setPhase('steady');
      return;
    }

    wasPresent.current = false;
    setPhase('exit');
    const timer = window.setTimeout(() => {
      setRendered(null);
      setPhase('steady');
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [exitMs, value]);

  return { phase, value: rendered } as const;
}
/* eslint-enable react-hooks/set-state-in-effect */

function TeamLogo({ team }: { readonly team: MatchHeaderTeamPresentation }) {
  const [failed, setFailed] = useState(false);
  if (team.logoUrl === null || failed) return null;
  return (
    <img
      alt=""
      className="match-header__team-logo"
      onError={() => setFailed(true)}
      src={team.logoUrl}
    />
  );
}

function Team({
  team,
  options,
}: {
  readonly team: MatchHeaderTeamPresentation;
  readonly options: TopScoreBarSettings;
}) {
  return (
    <>
      <div
        aria-label={`${team.name} logo`}
        className={`match-header__score-zone match-header__score-zone--logo match-header__score-zone--logo-${team.key}`}
        data-team-logo-slot={team.key}
        data-side={team.side ?? 'unknown'}
      >
        {options.showTeamLogo ? (
          <TeamLogo key={`${team.key}:${team.logoUrl ?? ''}`} team={team} />
        ) : null}
      </div>
      <div
        aria-label={`${team.name} score`}
        className={`match-header__score-zone match-header__score-zone--score match-header__score-zone--score-${team.key}`}
        data-team={team.key}
        data-side={team.side ?? 'unknown'}
      >
        <strong className="match-header__map-score" data-score={team.key}>
          {formatMatchHeaderScore(team.mapScore)}
        </strong>
        {options.showSeriesWins ? (
          <div
            className="match-header__win-slots"
            aria-label={`Series maps won ${team.seriesScore ?? 'unknown'}`}
          >
            {team.winSlots.map((won, index) => (
              <span key={index} data-series-win-slot={won ? 'won' : 'pending'} />
            ))}
          </div>
        ) : null}
      </div>
      <span
        aria-hidden="true"
        className={`match-header__side-accent match-header__side-accent--${team.key}`}
        data-side={team.side ?? 'unknown'}
      />
    </>
  );
}
export function TopScoreBar({
  design = 'current',
  snapshot,
  settings,
  presentationRevision = 0,
}: HudWidgetRendererProps) {
  const options = topScoreBarSettingsSchema.parse(settings.settings);
  const p = buildMatchHeaderPresentation(snapshot.payload);
  const timeout = p.timeoutPanel;
  const objective =
    p.objective.mode !== 'normal' &&
    p.objective.mode !== 'paused' &&
    p.clockTone !== 'timeout' &&
    p.clockTone !== 'paused';
  return (
    <section
      aria-label="比赛头部"
      className="match-header match-header__top-score"
      data-match-header-widget="top-score-bar"
      data-side-mapping={p.currentSideMapping}
    >
      <div className="match-header__score-shell">
        <Team team={p.teamA} options={options} />
        <div
          className={`match-header__center match-header__center--${p.clockTone}`}
          data-clock-tone={p.clockTone}
        >
          {p.clockTone === 'paused' ? (
            <div className="match-header__tech-pause" data-tech-pause="true">
              <svg aria-hidden="true" viewBox="0 0 18 18">
                <path d="M4 3h3v12H4zM11 3h3v12h-3z" />
              </svg>
              <strong>TECH PAUSE</strong>
            </div>
          ) : objective ? (
            <ObjectiveCenter
              design={design}
              cursor={snapshot.cursor}
              presentation={p}
              presentationRevision={presentationRevision}
            />
          ) : p.phaseLabel === 'ROUND OVER' ? (
            <div className="match-header__round-over" data-round-over="true">
              <span>ROUND</span>
              <strong>OVER</strong>
            </div>
          ) : (
            <>
              <div className="match-header__round-meta">
                {p.roundLabel === null ? null : <span data-round-label="true">{p.roundLabel}</span>}
              </div>
              <div className="match-header__clock" data-clock="true">
                <strong className="match-header__clock-value">{p.clockText ?? p.phaseLabel}</strong>
              </div>
            </>
          )}
        </div>
        <Team team={p.teamB} options={options} />
      </div>
      {options.showObjectiveAuxiliary &&
      objective &&
      (p.objective.mode === 'planted' || p.objective.mode === 'defusing') &&
      !p.objective.stateOnly ? (
        <ObjectiveFuse
          center={p.objective}
          cursor={snapshot.cursor}
          presentationRevision={presentationRevision}
        />
      ) : null}
      <MatchHeaderPanels
        key={`panels:${presentationRevision}:${options.showAliveMatchup}:${options.showTimeout}`}
        aliveCount={options.showAliveMatchup ? p.objective.aliveCount : null}
        teamASide={p.teamA.side}
        teamBSide={p.teamB.side}
        timeout={options.showTimeout ? timeout : null}
      />
    </section>
  );
}

function MatchHeaderPanels({
  aliveCount,
  teamASide,
  teamBSide,
  timeout,
}: {
  readonly aliveCount: string | null;
  readonly teamASide: MatchHeaderTeamPresentation['side'];
  readonly teamBSide: MatchHeaderTeamPresentation['side'];
  readonly timeout: ReturnType<typeof buildMatchHeaderPresentation>['timeoutPanel'];
}) {
  const timeoutPresence = usePanelPresence(timeout);
  const alivePresence = usePanelPresence(aliveCount);
  const visibleTimeout = timeoutPresence.value;
  const visibleAlive = alivePresence.value;

  return (
    <>
      {visibleTimeout?.owner === 'a' ? (
        <TimeoutPanel
          motionPhase={timeoutPresence.phase}
          ownerSide={teamASide}
          side="a"
          timeout={visibleTimeout}
        />
      ) : null}
      {visibleTimeout?.owner === 'b' ? (
        <TimeoutPanel
          motionPhase={timeoutPresence.phase}
          ownerSide={teamBSide}
          side="b"
          timeout={visibleTimeout}
        />
      ) : null}
      {visibleAlive === null ? null : (
        <div
          aria-hidden={alivePresence.phase === 'exit'}
          aria-label={`存活人数 ${visibleAlive}`}
          className="match-header__alive-matchup"
          data-motion-phase={alivePresence.phase}
        >
          <strong data-side={teamASide ?? 'unknown'}>{visibleAlive.split('v')[0]}</strong>
          <span>VS</span>
          <strong data-side={teamBSide ?? 'unknown'}>{visibleAlive.split('v')[1]}</strong>
        </div>
      )}
    </>
  );
}

function TimeoutPanel({
  timeout,
  side,
  ownerSide,
  motionPhase,
}: {
  readonly timeout: NonNullable<ReturnType<typeof buildMatchHeaderPresentation>['timeoutPanel']>;
  readonly side: 'a' | 'b';
  readonly ownerSide: MatchHeaderTeamPresentation['side'];
  readonly motionPhase: PanelMotionPhase;
}) {
  return (
    <div
      className={`match-header__timeout-panel match-header__timeout-panel--${side}`}
      data-timeout-owner={side}
      data-side={ownerSide ?? 'unknown'}
      data-timeout-panel="true"
      data-motion-phase={motionPhase}
      aria-hidden={motionPhase === 'exit'}
      aria-label="TACTICAL TIMEOUT"
    >
      <strong className="match-header__timeout-label">TACTICAL TIMEOUT</strong>
      <span className="match-header__timeout-count">{timeout.remaining ?? '—'} LEFT</span>
    </div>
  );
}
