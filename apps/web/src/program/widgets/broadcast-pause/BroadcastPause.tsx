import {
  placementToBox,
  playerRailSettingsSchema,
  topScoreBarSettingsSchema,
  type HudResolvedPreset,
} from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { hudDesignForVariant, type HudDesign } from '../../hud-design';
import { buildMatchHeaderPresentation } from '../match-header/presentation';
import { RoundHistoryPanel } from '../match-header/RoundHistoryPanel';
import { SeriesStrip } from '../match-header/SeriesStrip';
import { buildPlayerRailsPresentation } from '../player-rails/presentation';
import { BroadcastBrand, type BroadcastBranding } from './BroadcastBrand';
import { PauseRoster } from './PauseRoster';
import { PauseScoreBar } from './PauseScoreBar';
import { PauseNotice } from './PauseNotice';
import './broadcast-pause.css';

export function BroadcastPause({
  snapshot,
  resolvedPreset,
  design,
  branding,
}: {
  readonly snapshot: ProgramSnapshot;
  readonly resolvedPreset: HudResolvedPreset;
  readonly design: HudDesign;
  readonly branding?: BroadcastBranding | undefined;
}) {
  const p = buildMatchHeaderPresentation(snapshot.payload);
  const rails = buildPlayerRailsPresentation(snapshot.payload);
  const options = topScoreBarSettingsSchema.parse(resolvedPreset.widgets['top-score-bar'].settings);
  const left = playerRailSettingsSchema.parse(resolvedPreset.widgets['team-ct-rail'].settings);
  const right = playerRailSettingsSchema.parse(resolvedPreset.widgets['team-t-rail'].settings);
  const layout = resolvedPreset.layout.widgets;
  const historySide = p.timeoutPanel?.owner === 'b' ? 'left' : 'right';
  const stripPlacement = layout['series-strip'];
  const stripBox = placementToBox('series-strip', stripPlacement);
  const stripDesign = hudDesignForVariant(resolvedPreset.widgets['series-strip'].variant);
  return (
    <div
      className="broadcast-pause hud-widget-design hud-redraw"
      data-hud-design={design}
      data-broadcast-pause={p.clockTone}
      data-pause-owner={p.timeoutPanel?.owner ?? 'unknown'}
    >
      {stripPlacement.visible ? (
        <div
          className="gameplay-hud__widget hud-widget-design hud-redraw"
          data-hud-widget="series-strip"
          data-hud-design={stripDesign}
          style={{
            left: stripBox.left,
            top: stripBox.top,
            width: stripBox.width,
            height: stripBox.height,
          }}
        >
          <SeriesStrip
            snapshot={snapshot}
            resolvedPreset={resolvedPreset}
            widgetId="series-strip"
            placement={stripPlacement}
            box={stripBox}
            design={stripDesign}
            settings={resolvedPreset.widgets['series-strip']}
          />
        </div>
      ) : null}
      <PauseNotice presentation={p} />
      {layout['round-history'].visible && p.roundHistory ? (
        <div className="broadcast-pause__history" data-pause-history-side={historySide}>
          <RoundHistoryPanel history={p.roundHistory} mode="pause" />
        </div>
      ) : null}
      <div className="broadcast-pause__dock">
        <PauseScoreBar
          presentation={p}
          rails={rails}
          options={options}
          roundNumber={snapshot.payload.map.roundNumber}
          leftSummaryVisible={layout['team-ct-rail'].visible && left.showTeamSummary}
          rightSummaryVisible={layout['team-t-rail'].visible && right.showTeamSummary}
        />
        <div className="broadcast-pause__body">
          <PauseRoster
            rail={rails.left}
            options={left}
            physicalSide="left"
            visible={layout['team-ct-rail'].visible}
          />
          <BroadcastBrand branding={branding} competition={p.competitionName} stage={p.stageName} />
          <PauseRoster
            rail={rails.right}
            options={right}
            physicalSide="right"
            visible={layout['team-t-rail'].visible}
          />
        </div>
      </div>
    </div>
  );
}
