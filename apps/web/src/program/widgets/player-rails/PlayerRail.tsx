import { playerRailSettingsSchema } from '@mizar/hud-config';
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';

import { PlayerCard } from './PlayerCard';
import { buildPlayerRailsPresentation } from './presentation';
import { TeamSummary } from './TeamSummary';

export function PlayerRail({
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
          <TeamSummary phase={presentation.phase} side={side} summary={rail.summary} />
        ) : null}
      </div>
      <div className="player-rail__header" data-rail-header="true">
        {options.showTeamName ? <strong>{rail.entrantName ?? 'TEAM'}</strong> : null}
      </div>
      <div className="player-rail__players">
        {rail.players.slice(0, 5).map((player) => (
          <PlayerCard
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
