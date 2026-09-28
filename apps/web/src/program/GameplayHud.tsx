import { presentationBoundaryKey } from './presentation-boundary';
import type { RadarProps } from './widgets/radar/Radar';
import type { CSSProperties, ReactElement } from 'react';

import { HUD_WIDGET_REGISTRY, placementToBox, type HudResolvedPreset } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';

import {
  getHudRendererEntry,
  HUD_RENDERER_REGISTRY,
  type HudRendererRegistry,
} from './hud-renderer-registry';
import './gameplay-hud.css';
import './widgets/focused-player/focused-player.css';
import './widgets/match-header/match-header.css';
import './widgets/player-rails/player-rails.css';
import './widgets/player-status-effects/player-status-effects.css';

export interface GameplayHudProps {
  readonly radarClient?: RadarProps['client'];
  readonly radarSnapshot?: RadarProps['snapshot'];
  readonly snapshot: ProgramSnapshot | null;
  readonly presentationRevision?: number;
  readonly resolvedPreset: HudResolvedPreset;
  /** Test-only injection keeps the production registry closed while exercising the React seam. */
  readonly rendererRegistry?: HudRendererRegistry;
}

export function themeStyle(theme: HudResolvedPreset['theme']): CSSProperties {
  return {
    '--mizar-event-accent': theme.brandColor,
    '--mizar-hud-text-primary': theme.semantic.colors.textPrimary,
    '--mizar-hud-text-muted': theme.semantic.colors.textMuted,
    '--mizar-side-ct': theme.semantic.colors.sideCt,
    '--mizar-side-t': theme.semantic.colors.sideT,
    '--mizar-hud-state-danger': theme.semantic.colors.stateDanger,
    '--mizar-hud-state-warning': theme.semantic.colors.stateWarning,
    '--mizar-hud-state-success': theme.semantic.colors.stateSuccess,
    '--mizar-hud-state-unknown': theme.semantic.colors.stateUnknown,
    '--mizar-hud-objective-bomb': theme.semantic.colors.objectiveBomb,
    '--mizar-hud-objective-defuse': theme.semantic.colors.objectiveDefuse,
    '--mizar-hud-surface-primary': theme.semantic.surface.primary,
    '--mizar-hud-surface-strong': theme.semantic.surface.strong,
    '--mizar-hud-surface-opacity': theme.semantic.surface.opacity,
    '--mizar-hud-border-opacity': theme.semantic.surface.borderOpacity,
    '--mizar-hud-radius-sm': `${theme.semantic.radius.sm}px`,
    '--mizar-hud-radius-md': `${theme.semantic.radius.md}px`,
    '--mizar-hud-radius-lg': `${theme.semantic.radius.lg}px`,
    '--mizar-hud-font-family': theme.semantic.fontFamily,
  } as CSSProperties;
}

export function GameplayHud({
  snapshot,
  radarClient,
  radarSnapshot,
  resolvedPreset,
  presentationRevision = 0,
  rendererRegistry = HUD_RENDERER_REGISTRY,
}: GameplayHudProps) {
  const programFresh = snapshot?.payload.status.telemetry === 'fresh';
  const radarAvailable = radarClient !== undefined || radarSnapshot != null;
  if (!programFresh && !radarAvailable) return null;

  return (
    <div
      className="gameplay-hud"
      data-gameplay-hud="true"
      data-hud-preset-id={resolvedPreset.preset.id}
      style={themeStyle(resolvedPreset.theme)}
    >
      {HUD_WIDGET_REGISTRY.map((descriptor) => {
        const placement = resolvedPreset.layout.widgets[descriptor.id];
        if (placement === undefined || !placement.visible) return null;
        const rendererEntry = getHudRendererEntry(descriptor.id, rendererRegistry);
        if (rendererEntry.renderer === null) return null;

        const box = placementToBox(descriptor.id, placement);
        let content: ReactElement;
        if (rendererEntry.source === 'program') {
          if (!programFresh || snapshot === null) return null;
          const Renderer = rendererEntry.renderer;
          content = (
            <Renderer
              box={box}
              placement={placement}
              resolvedPreset={resolvedPreset}
              settings={resolvedPreset.widgets[descriptor.id]}
              snapshot={snapshot}
              presentationRevision={presentationRevision}
              widgetId={descriptor.id}
            />
          );
        } else {
          if (!radarAvailable) return null;
          const Renderer = rendererEntry.renderer;
          content = (
            <Renderer
              box={box}
              placement={placement}
              radarClient={radarClient}
              radarSnapshot={radarSnapshot}
              presentationRevision={presentationRevision}
              resolvedPreset={resolvedPreset}
              settings={resolvedPreset.widgets[descriptor.id]}
              widgetId={descriptor.id}
            />
          );
        }

        return (
          <div
            className="gameplay-hud__widget"
            data-hud-widget={descriptor.id}
            data-renderer-availability={descriptor.rendererAvailability}
            key={
              rendererEntry.source === 'radar'
                ? 'radar'
                : `${descriptor.id}:${presentationBoundaryKey(snapshot, undefined)}`
            }
            style={{
              height: `${box.height}px`,
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
            }}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
