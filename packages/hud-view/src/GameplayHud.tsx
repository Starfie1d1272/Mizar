import type { ResolvedHudModule } from '@mizar/broadcast-config';
import { AssetFonts, assetStyle, useAssetUrl } from './assets.js';
import { presentationBoundaryKey } from './presentation-boundary.js';
import type { RadarProps } from './widgets/radar/Radar.js';
import { memo, useMemo, type CSSProperties, type ReactElement } from 'react';

import {
  HUD_WIDGET_REGISTRY,
  DEFAULT_PLACEMENTS,
  placementToBox,
  topScoreBarSettingsSchema,
  type HudResolvedPreset,
} from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';

import {
  getHudRendererEntry,
  HUD_RENDERER_REGISTRY,
  type HudRendererRegistry,
} from './hud-renderer-registry.js';
import './gameplay-hud.css';
import './widgets/focused-player/focused-player.css';
import './widgets/match-header/match-header.css';
import './widgets/player-rails/player-rails.css';
import './widgets/player-status-effects/player-status-effects.css';
import './designs/shared.css';
import './designs/ewc.css';
import './designs/iem.css';
import './designs/esl.css';
import './designs/perfectworld.css';
import './designs/native.css';
import { hudDesignForVariant } from './hud-design.js';
import { AllChat } from './widgets/player-rails/AllChat.js';
import { BroadcastPause } from './widgets/broadcast-pause/BroadcastPause.js';
import { hasSeriesMapStrip } from './widgets/match-header/presentation.js';
import type { BroadcastBranding } from './widgets/broadcast-pause/BroadcastBrand.js';

type NativeHud = Extract<ResolvedHudModule, { renderer: 'native' }>;

export interface GameplayHudProps {
  readonly overlays?: NativeHud['overlays'] | undefined;
  readonly accent?: NativeHud['accent'] | undefined;
  readonly eventAccent?: string | null | undefined;
  readonly staticFrame?: boolean | undefined;
  readonly radarSource?: RadarProps['source'];
  readonly radarSnapshot?: RadarProps['snapshot'];
  readonly snapshot: ProgramSnapshot | null;
  readonly presentationRevision?: number;
  readonly gg?: boolean;
  readonly resolvedPreset: HudResolvedPreset;
  readonly broadcastBranding?: BroadcastBranding;
  /** Test-only injection keeps the production registry closed while exercising the React seam. */
  readonly rendererRegistry?: HudRendererRegistry;
}

export function themeStyle(
  theme: HudResolvedPreset['theme'],
  accent = theme.brandColor,
): CSSProperties {
  return {
    '--mizar-hud-accent': accent,
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
  overlays,
  accent,
  eventAccent,
  radarSource,
  staticFrame,
  radarSnapshot,
  resolvedPreset,
  presentationRevision = 0,
  gg = false,
  rendererRegistry = HUD_RENDERER_REGISTRY,
  broadcastBranding,
}: GameplayHudProps) {
  const resolve = useAssetUrl();
  const programFresh = snapshot?.payload.status.telemetry === 'fresh';
  const radarAvailable = radarSource !== undefined || radarSnapshot != null;
  const accentColor =
    accent?.source === 'fixed'
      ? accent.value
      : accent?.source === 'event'
        ? (eventAccent ?? accent.fallback)
        : resolvedPreset.theme.brandColor;
  const rootThemeStyle = useMemo(
    () => themeStyle(resolvedPreset.theme, accentColor),
    [resolvedPreset.theme, accentColor],
  );
  const rootAssetStyle = useMemo(() => assetStyle(resolve), [resolve]);
  const rootStyle = useMemo(
    () => ({ ...rootThemeStyle, ...rootAssetStyle }),
    [rootThemeStyle, rootAssetStyle],
  );
  const score = resolvedPreset.widgets['top-score-bar'];
  const showTimeoutFromSettings = useMemo(
    () => topScoreBarSettingsSchema.parse(score.settings).showTimeout,
    [score.settings],
  );
  const compactRadar =
    hudDesignForVariant(resolvedPreset.widgets.radar.variant) === 'current' &&
    resolvedPreset.layout.widgets.radar.anchor === DEFAULT_PLACEMENTS.radar.anchor &&
    resolvedPreset.layout.widgets.radar.offsetX === DEFAULT_PLACEMENTS.radar.offsetX &&
    resolvedPreset.layout.widgets.radar.offsetY === DEFAULT_PLACEMENTS.radar.offsetY &&
    (!programFresh ||
      !snapshot ||
      !resolvedPreset.layout.widgets['series-strip'].visible ||
      !hasSeriesMapStrip(snapshot.payload));
  const widgetLayouts = useMemo(
    () =>
      HUD_WIDGET_REGISTRY.map((descriptor) => {
        const placement = resolvedPreset.layout.widgets[descriptor.id];
        if (placement === undefined || !placement.visible) return null;
        const rendererEntry = getHudRendererEntry(descriptor.id, rendererRegistry);
        if (rendererEntry.renderer === null) return null;
        let box = placementToBox(descriptor.id, placement);
        if (descriptor.id === 'radar' && compactRadar) {
          // Only compact the standard slot. Explicit editor placements remain authoritative.
          box = { ...box, top: DEFAULT_PLACEMENTS['series-strip'].offsetY };
        }
        const design = hudDesignForVariant(resolvedPreset.widgets[descriptor.id].variant);
        const boxStyle: CSSProperties = {
          height: `${box.height}px`,
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
        };
        return { descriptor, placement, rendererEntry, box, design, boxStyle };
      }),
    [resolvedPreset, rendererRegistry, compactRadar],
  );

  if (!programFresh && !radarAvailable) return null;

  const chat = overlays?.chat;
  const autoChat = chat?.enabled === true && chat.placement === 'auto';
  const fixedChat =
    chat?.enabled && chat.placement !== 'auto' && chat.placement.visible ? chat.placement : null;
  const design = hudDesignForVariant(
    overlays?.pause.visual && overlays.pause.visual !== 'legacy'
      ? overlays.pause.visual
      : score.variant,
  );
  const phase = snapshot?.payload.clock?.phase;
  if (
    programFresh &&
    snapshot &&
    (overlays?.pause.enabled ??
      (resolvedPreset.layout.widgets['top-score-bar'].visible && showTimeoutFromSettings)) &&
    !gg &&
    (phase === 'paused' || phase === 'timeout_ct' || phase === 'timeout_t')
  ) {
    return (
      <div
        className="gameplay-hud"
        data-gameplay-hud="true"
        data-hud-preset-id={resolvedPreset.preset.id}
        style={rootStyle}
      >
        <AssetFonts />
        <BroadcastPause
          snapshot={snapshot}
          resolvedPreset={resolvedPreset}
          design={design}
          branding={broadcastBranding}
          chatEnabled={chat ? autoChat : undefined}
        />
        {fixedChat && snapshot ? (
          <FixedChat snapshot={snapshot} placement={fixedChat} design={design} />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="gameplay-hud"
      data-gameplay-hud="true"
      data-hud-preset-id={resolvedPreset.preset.id}
      style={rootStyle}
    >
      <AssetFonts />
      {fixedChat && snapshot && programFresh ? (
        <FixedChat
          snapshot={snapshot}
          placement={fixedChat}
          design={hudDesignForVariant(resolvedPreset.widgets['team-t-rail'].variant)}
        />
      ) : null}
      {autoChat &&
      snapshot &&
      programFresh &&
      !resolvedPreset.layout.widgets['team-t-rail'].visible ? (
        <AutoChat snapshot={snapshot} resolvedPreset={resolvedPreset} />
      ) : null}
      {widgetLayouts.map((entry) => {
        if (entry === null) return null;
        const { descriptor, placement, rendererEntry, box, design: widgetDesign, boxStyle } = entry;
        let content: ReactElement;
        if (rendererEntry.source === 'program') {
          if (!programFresh || snapshot === null) return null;
          const Renderer = rendererEntry.renderer;
          content = (
            <Renderer
              design={widgetDesign}
              box={box}
              placement={placement}
              resolvedPreset={resolvedPreset}
              settings={resolvedPreset.widgets[descriptor.id]}
              snapshot={snapshot}
              presentationRevision={presentationRevision}
              gg={gg}
              chatEnabled={chat ? autoChat : undefined}
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
              staticFrame={staticFrame}
              radarSource={radarSource}
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
            className={`gameplay-hud__widget hud-widget-design${widgetDesign === 'current' ? '' : ' hud-redraw'}`}
            data-hud-design={widgetDesign}
            data-hud-widget={descriptor.id}
            data-renderer-availability={descriptor.rendererAvailability}
            key={
              rendererEntry.source === 'radar'
                ? 'radar'
                : `${descriptor.id}:${presentationBoundaryKey(snapshot, undefined)}`
            }
            style={boxStyle}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

const FixedChat = memo(function FixedChat({
  snapshot,
  placement,
  design,
}: {
  snapshot: ProgramSnapshot;
  placement: import('@mizar/hud-config').HudWidgetPlacement;
  design: import('./hud-design.js').HudDesign;
}) {
  const box = placementToBox('team-t-rail', placement);
  return (
    <div
      className={`gameplay-hud__widget hud-fixed-chat hud-widget-design${design === 'current' ? '' : ' hud-redraw'}`}
      data-hud-design={design}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <AllChat design={design} messages={snapshot.payload.allChat ?? []} />
    </div>
  );
});
const AutoChat = memo(function AutoChat({
  snapshot,
  resolvedPreset,
}: {
  snapshot: ProgramSnapshot;
  resolvedPreset: HudResolvedPreset;
}) {
  const box = placementToBox('team-t-rail', resolvedPreset.layout.widgets['team-t-rail']);
  const design = hudDesignForVariant(resolvedPreset.widgets['team-t-rail'].variant);
  return (
    <div
      className={`gameplay-hud__widget hud-widget-design${design === 'current' ? '' : ' hud-redraw'}`}
      data-hud-design={design}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <section className="player-rail player-rail--right" data-all-chat-host="true">
        <AllChat design={design} messages={snapshot.payload.allChat ?? []} />
      </section>
    </div>
  );
});
