import { useAliveMatchup } from './useAliveMatchup';
import { presentationBoundaryKey } from '../../presentation-boundary';
import { useBalancedTeamNames } from './useBalancedTeamNames';
import { assetForCanonicalKey } from '../player-rails/presentation';
import type { CSSProperties } from 'react';
import { topScoreBarSettingsSchema, type TopScoreBarSettings } from '@mizar/hud-config';
/** Match composition adapted from Lexogrine cs2-react-hud@7874750c97fcecd8f72eb3fad382917e035ec651
 * (MIT). Angular shell, series pips and objective choreography follow the user-provided reference.
 * Team binding and all gameplay progress remain owned by the existing presentation join/Core. */
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import { useEffect, useRef, useState } from 'react';
import { ObjectiveCenter, ObjectiveDefused, ObjectiveFuse } from './ObjectiveCenter';
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

function TeamLogo({
  team,
  fallback = false,
}: {
  readonly team: MatchHeaderTeamPresentation;
  readonly fallback?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (team.logoUrl === null || team.logoUrl === failedUrl)
    return fallback ? <span className="shanghai-winner-name">{team.name}</span> : null;
  return (
    <img
      alt=""
      className="match-header__team-logo"
      onError={() => setFailedUrl(team.logoUrl)}
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
  gg = false,
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
      {(design === 'iem' || design === 'esl') && (p.competitionName || p.stageName) ? (
        <div className="broadcast-event-ribbon">
          <span>{p.competitionName}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M7 2h10v10a5 5 0 0 1-4 5v3h4v2H7v-2h4v-3a5 5 0 0 1-4-5zM5 4H2v4q0 5 5 5v-2Q4 11 4 8V6h1zM19 4h3v4q0 5-5 5v-2q3 0 3-3V6h-1z" />
          </svg>
          <span>{p.stageName}</span>
        </div>
      ) : null}
      <div className="match-header__score-shell">
        <Team team={p.teamA} options={options} />
        <div
          className={`match-header__center match-header__center--${p.clockTone}`}
          data-clock-tone={p.clockTone}
        >
          {gg ? (
            <strong className="match-header__gg" data-map-end-gg="true">
              GG
            </strong>
          ) : p.clockTone === 'paused' ? (
            <div className="match-header__tech-pause" data-tech-pause="true">
              <svg aria-hidden="true" viewBox="0 0 18 18">
                <path d="M4 3h3v12H4zM11 3h3v12h-3z" />
              </svg>
              <strong>TECH PAUSE</strong>
            </div>
          ) : shanghai && snapshot.payload.bomb?.state === 'defused' ? (
            <ObjectiveDefused />
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
        aliveBoundary={`${presentationBoundaryKey(snapshot, undefined)}:${snapshot.payload.map.roundNumber}:${p.objective.aliveSample !== null}:${snapshot.payload.players
          .map((player) => `${player.sourcePlayerId}:${player.side}`)
          .sort()
          .join(',')}`}
        aliveCount={!shanghai && options.showAliveMatchup ? p.objective.aliveSample : null}
        cursor={snapshot.cursor}
        teamASide={p.teamA.side}
        teamBSide={p.teamB.side}
        timeout={options.showTimeout ? timeout : null}
      />
    </section>
  );
}

function MatchHeaderPanels({
  aliveBoundary,
  aliveCount,
  cursor,
  teamASide,
  teamBSide,
  timeout,
}: {
  readonly aliveBoundary: string;
  readonly aliveCount: string | null;
  readonly cursor: HudWidgetRendererProps['snapshot']['cursor'];
  readonly teamASide: MatchHeaderTeamPresentation['side'];
  readonly teamBSide: MatchHeaderTeamPresentation['side'];
  readonly timeout: ReturnType<typeof buildMatchHeaderPresentation>['timeoutPanel'];
}) {
  const timeoutPresence = usePanelPresence(timeout);
  const visibleTimeout = timeoutPresence.value;

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
      <AliveMatchupPanel
        key={aliveBoundary}
        sample={aliveCount}
        cursor={cursor}
        teamASide={teamASide}
        teamBSide={teamBSide}
      />
    </>
  );
}

function AliveMatchupPanel({
  sample,
  cursor,
  teamASide,
  teamBSide,
}: {
  readonly sample: string | null;
  readonly cursor: HudWidgetRendererProps['snapshot']['cursor'];
  readonly teamASide: MatchHeaderTeamPresentation['side'];
  readonly teamBSide: MatchHeaderTeamPresentation['side'];
}) {
  const transientAlive = useAliveMatchup(sample, cursor);
  const presence = usePanelPresence(transientAlive);
  const visible = presence.value;
  return visible === null ? null : (
    <div
      aria-hidden={presence.phase === 'exit'}
      aria-label={`存活人数 ${visible}`}
      className="match-header__alive-matchup"
      data-motion-phase={presence.phase}
    >
      <strong data-side={teamASide ?? 'unknown'}>{visible.split('v')[0]}</strong>
      <span>VS</span>
      <strong data-side={teamBSide ?? 'unknown'}>{visible.split('v')[1]}</strong>
    </div>
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

function ShanghaiKit() {
  const asset = assetForCanonicalKey('equipment.defuse-kit');
  return asset === null ? null : (
    <span
      className="shanghai-kit"
      aria-hidden="true"
      style={{ '--shanghai-kit': `url("${asset.outputPath}")` } as CSSProperties}
    />
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
  const actionOwner = p.teamA.side === actionSide ? 'a' : p.teamB.side === actionSide ? 'b' : null;
  const bombOwner = p.teamA.side === 'T' ? 'a' : p.teamB.side === 'T' ? 'b' : null;
  const winner =
    payload.round?.phase === 'over'
      ? [p.teamA, p.teamB].find(
          (team) => team.side !== null && team.side === payload.round?.winnerSide,
        )
      : undefined;
  const active = p.objective.mode === 'planting' || p.objective.mode === 'defusing';
  const remaining = action?.remainingSeconds;
  const timedAction =
    active &&
    actionOwner !== null &&
    action != null &&
    remaining != null &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    ((p.objective.mode === 'planting' && action.kind === 'plant') ||
      (p.objective.mode === 'defusing' && action.kind === 'defuse'));
  return (
    <>
      <div className="shanghai-round-strip">
        <span>
          {p.roundNumber === null
            ? 'ROUND —'
            : `ROUND ${p.roundNumber}${p.roundNumber <= 24 ? '/24' : ''}`}
        </span>
      </div>
      {options.showObjectiveAuxiliary && bombOwner !== null && p.objective.fuse !== null ? (
        <div className="shanghai-fuse" data-owner={bombOwner} data-objective-track="fuse">
          <i style={{ width: `${p.objective.fuse * 100}%` }} />
        </div>
      ) : null}
      {options.showObjectiveAuxiliary && timedAction ? (
        <>
          {action.kind === 'defuse' && p.objective.action !== null ? (
            <div className="shanghai-action-track" data-owner={actionOwner} data-kind={action.kind}>
              <i style={{ width: `${(1 - p.objective.action) * 100}%` }} />
              {p.objective.hasKit ? <ShanghaiKit /> : null}
            </div>
          ) : null}
          <div className="shanghai-event-panel" data-owner={actionOwner} data-kind={action.kind}>
            {action.kind === 'defuse' && p.objective.hasKit ? <ShanghaiKit /> : null}
            {action.kind === 'defuse' ? <b>{remaining.toFixed(2).replace('.', ':')}</b> : null}
            <strong>{actor?.displayName ?? 'PLAYER'}</strong>
            <span>{action.kind === 'plant' ? 'PLANTING BOMB' : 'DEFUSING THE BOMB'}</span>
            {action.kind === 'plant' ? <b>{remaining.toFixed(2).replace('.', ':')}</b> : null}
          </div>
        </>
      ) : winner ? (
        <div
          className="shanghai-event-panel shanghai-round-winner"
          data-owner={winner.key}
          data-side={winner.side}
        >
          <TeamLogo team={winner} fallback />
          <strong>ROUND WINNER</strong>
        </div>
      ) : null}
    </>
  );
}
