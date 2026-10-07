import { playerRailSettingsSchema } from '@mizar/hud-config';
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';

import { PlayerCard } from './PlayerCard';
import { buildPlayerRailsPresentation } from './presentation';
import { TeamSummary } from './TeamSummary';

export function PlayerRail({
  design = 'current',
  snapshot,
  settings,
  widgetId,
  presentationRevision = 0,
}: HudWidgetRendererProps) {
  const options = playerRailSettingsSchema.parse(settings.settings);
  const presentation = buildPlayerRailsPresentation(snapshot.payload);
  const physicalSide = widgetId === 'team-t-rail' ? 'right' : 'left';
  const rail = physicalSide === 'left' ? presentation.left : presentation.right;
  const side = rail.side;
  const remaining = snapshot.payload.bomb?.explosion?.remainingSeconds;
  const showPrediction =
    snapshot.payload.status.telemetry === 'fresh' &&
    snapshot.payload.bombDamage?.status === 'available' &&
    (snapshot.payload.bomb?.state === 'planted' || snapshot.payload.bomb?.state === 'defusing') &&
    snapshot.payload.round?.phase !== 'over' &&
    snapshot.payload.clock?.phase !== 'over' &&
    snapshot.payload.clock?.phase !== 'paused' &&
    remaining != null &&
    Number.isFinite(remaining) &&
    remaining >= 0 &&
    remaining <= 10;
  const predictionFresh =
    snapshot.payload.status.telemetry === 'fresh' &&
    snapshot.payload.status.identity !== 'mismatch' &&
    snapshot.payload.clock?.phase !== 'paused';
  const explosionHandoff = predictionFresh && snapshot.payload.bomb?.state === 'exploded';
  const cursor = snapshot.cursor;
  const predictionScope = predictionFresh
    ? JSON.stringify([
        cursor.producerInstanceId,
        cursor.liveSessionId,
        cursor.programSourceGeneration,
        cursor.mapEpoch,
        snapshot.payload.match?.matchId,
        presentationRevision,
      ])
    : null;
  return (
    <section
      aria-label={`${physicalSide === 'left' ? '左' : '右'}选手栏`}
      className={`player-rail player-rail--${physicalSide} player-rail--${side.toLowerCase()}`}
      data-entrant={rail.entrantKey ?? 'unbound'}
      data-player-rail={side}
      data-physical-side={physicalSide}
      data-player-rail-phase={presentation.phase}
    >
      <div className="player-rail__summary-slot" data-team-summary-slot="true">
        {options.showTeamSummary ? (
          <TeamSummary
            design={design}
            phase={presentation.phase}
            side={side}
            summary={rail.summary}
          />
        ) : null}
      </div>
      <div className="player-rail__header" data-rail-header="true">
        {options.showTeamName ? <strong>{rail.entrantName ?? 'TEAM'}</strong> : null}
      </div>
      <div className="player-rail__players">
        {rail.players.slice(0, 5).map((player) => (
          <PlayerCard
            explosionHandoff={explosionHandoff}
            predictionScope={predictionScope}
            predictionSequence={cursor.programReceiveSequence ?? cursor.runtimeSeq}
            predictionRoundNumber={snapshot.payload.map.roundNumber}
            prediction={
              showPrediction
                ? snapshot.payload.bombDamage.players.find(
                    (entry) =>
                      entry.sourcePlayerId === player.sourcePlayerId &&
                      (entry.status === 'predicted' || entry.reason === 'prediction-loading'),
                  )
                : undefined
            }
            design={design}
            key={player.sourcePlayerId}
            cursor={snapshot.cursor}
            physicalSide={physicalSide}
            player={player}
            options={options}
            presentationRevision={presentationRevision}
          />
        ))}
        {Array.from({ length: Math.max(0, 5 - rail.players.length) }, (_, index) => (
          <div aria-hidden="true" className="player-rail__empty-card" key={`empty-${index}`} />
        ))}
      </div>
    </section>
  );
}
