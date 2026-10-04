import { topScoreBarSettingsSchema, type TopScoreBarSettings } from '@mizar/hud-config';
/** Match composition adapted from Lexogrine cs2-react-hud@7874750c97fcecd8f72eb3fad382917e035ec651
 * (MIT). Angular shell, series pips and objective choreography follow the user-provided reference.
 * Team binding and all gameplay progress remain owned by the existing presentation join/Core. */
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

function useBalancedTeamNames(names: string, design: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nodes = [
      ...(ref.current?.querySelectorAll<HTMLElement>('.match-header__team-name') ?? []),
    ];
    const fit = () => {
      for (const node of nodes) node.style.fontSize = '';
      const sizes = nodes
        .filter((node) => node.clientWidth > 0)
        .map((node) => {
          const base = Number.parseFloat(getComputedStyle(node).fontSize);
          return base * Math.min(1, node.clientWidth / Math.max(1, node.scrollWidth));
        });
      if (sizes.length) for (const node of nodes) node.style.fontSize = `${Math.min(...sizes)}px`;
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    for (const node of nodes) observer?.observe(node);
    void document.fonts?.ready.then(fit);
    fit();
    return () => observer?.disconnect();
  }, [names, design]);
  return ref;
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
        <span className="match-header__team-name" title={team.name}>
          {team.name}
        </span>
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
  const nameContainer = useBalancedTeamNames(`${p.teamA.name}:${p.teamB.name}`, design);
  const shanghai = design === 'perfectworld';
  const objective =
    p.objective.mode !== 'normal' &&
    p.objective.mode !== 'paused' &&
    p.clockTone !== 'timeout' &&
    p.clockTone !== 'paused';
  return (
    <section
      ref={nameContainer}
      aria-label="比赛头部"
      className="match-header match-header__top-score"
      data-match-header-widget="top-score-bar"
      data-side-mapping={p.currentSideMapping}
      data-freeze={snapshot.payload.round?.phase === 'freezetime'}
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
          ) : objective && !(shanghai && p.objective.mode === 'planting') ? (
            <ObjectiveCenter
              design={design}
              cursor={snapshot.cursor}
              presentation={p}
              presentationRevision={presentationRevision}
            />
          ) : !shanghai && p.phaseLabel === 'ROUND OVER' ? (
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
                <strong className="match-header__clock-value">
                  {shanghai && p.phaseLabel === 'ROUND OVER'
                    ? '0:00'
                    : (p.clockText ?? p.phaseLabel)}
                </strong>
              </div>
            </>
          )}
        </div>
        <Team team={p.teamB} options={options} />
      </div>
      {shanghai ? <ShanghaiPanels snapshot={snapshot} presentation={p} options={options} /> : null}
      {!shanghai &&
      options.showObjectiveAuxiliary &&
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
        aliveCount={!shanghai && options.showAliveMatchup ? p.objective.aliveCount : null}
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

function ShanghaiPanels({
  snapshot,
  presentation: p,
  options,
}: {
  readonly snapshot: HudWidgetRendererProps['snapshot'];
  readonly presentation: ReturnType<typeof buildMatchHeaderPresentation>;
  readonly options: TopScoreBarSettings;
}) {
  const payload = snapshot.payload;
  const action = payload.status.telemetry === 'fresh' ? payload.bomb?.action : null;
  const actor = payload.players.find(
    (player) =>
      player.sourcePlayerId === action?.sourcePlayerId && player.lineupEvidence === 'current',
  );
  const actionSide = action?.kind === 'defuse' ? 'CT' : 'T';
  const actionOwner = p.teamA.side === actionSide ? 'a' : 'b';
  const winner =
    payload.round?.phase === 'over'
      ? [p.teamA, p.teamB].find(
          (team) => team.side !== null && team.side === payload.round?.winnerSide,
        )
      : undefined;
  const active = p.objective.mode === 'planting' || p.objective.mode === 'defusing';
  const remaining = action?.remainingSeconds;
  return (
    <>
      <div className="shanghai-round-strip">
        <span>
          {payload.map.roundNumber === null
            ? 'ROUND —'
            : `ROUND ${payload.map.roundNumber + (payload.round?.phase === 'over' ? 0 : 1)}${payload.map.roundNumber < 24 ? '/24' : ''}`}
        </span>
      </div>
      {options.showObjectiveAuxiliary && p.objective.fuse !== null ? (
        <div
          className="shanghai-fuse"
          data-owner={p.teamA.side === 'T' ? 'a' : 'b'}
          data-objective-track="fuse"
        >
          <i style={{ width: `${p.objective.fuse * 100}%` }} />
        </div>
      ) : null}
      {options.showObjectiveAuxiliary && active && action ? (
        <>
          {action.kind === 'defuse' && p.objective.action !== null ? (
            <div className="shanghai-action-track" data-owner={actionOwner} data-kind={action.kind}>
              <i style={{ width: `${p.objective.action * 100}%` }} />
            </div>
          ) : null}
          <div className="shanghai-event-panel" data-owner={actionOwner} data-kind={action.kind}>
            {action.kind === 'defuse' ? (
              <b>{remaining == null ? '—' : Math.max(0, remaining).toFixed(2).replace('.', ':')}</b>
            ) : null}
            <strong>{actor?.displayName ?? 'PLAYER'}</strong>
            <span>{action.kind === 'plant' ? 'PLANTING BOMB' : 'DEFUSING THE BOMB'}</span>
            {action.kind === 'plant' ? (
              <b>{remaining == null ? '—' : Math.max(0, remaining).toFixed(2).replace('.', ':')}</b>
            ) : null}
          </div>
        </>
      ) : winner ? (
        <div
          className="shanghai-event-panel shanghai-round-winner"
          data-owner={winner.key}
          data-side={winner.side}
        >
          <TeamLogo team={winner} />
          <strong>ROUND WINNER</strong>
        </div>
      ) : null}
    </>
  );
}
