import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';

import {
  HUD_CANVAS_HEIGHT,
  HUD_CANVAS_WIDTH,
  type HudResolvedPreset,
  type HudWidgetId,
} from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';

import type { RadarProps } from '../program/widgets/radar/Radar';
import { HudEditorOverlay } from '../program/HudEditorOverlay';
import { GameplayHud } from '../program/GameplayHud';
import { hasAcceptedProgramSnapshot } from '../program/presentation-boundary';
import type { LocalChannelConnectionState } from '../realtime';

export interface HudCanvasPreviewProps {
  readonly radarClient?: RadarProps['client'];
  readonly radarSnapshot?: RadarProps['snapshot'];
  readonly resolvedPreset: HudResolvedPreset;
  readonly snapshot: ProgramSnapshot | null;
  readonly presentationRevision?: number;
  readonly connectionState: LocalChannelConnectionState;
  readonly liveSource: boolean;
  readonly editorMode?: 'layout' | 'preview';
  readonly selectedWidgetId: HudWidgetId | null;
  readonly showGrid: boolean;
  readonly showCenter: boolean;
  readonly showSafeArea: boolean;
  readonly editorInteractive?: boolean;
  readonly canvasFrameRef?: RefObject<HTMLDivElement | null>;
  readonly onWidgetPointerDown?:
    ((widgetId: HudWidgetId, event: PointerEvent<HTMLButtonElement>) => void) | undefined;
  readonly onRadarResizePointerDown?:
    ((event: PointerEvent<HTMLButtonElement>) => void) | undefined;
}

export function HudCanvasPreview({
  resolvedPreset,
  radarClient,
  radarSnapshot,
  snapshot,
  presentationRevision = 0,
  connectionState,
  liveSource,
  editorMode = 'layout',
  selectedWidgetId,
  showGrid,
  showCenter,
  showSafeArea,
  editorInteractive = true,
  canvasFrameRef,
  onWidgetPointerDown,
  onRadarResizePointerDown,
}: HudCanvasPreviewProps) {
  const internalFrameRef = useRef<HTMLDivElement>(null);
  const frameRef = canvasFrameRef ?? internalFrameRef;
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const updateScale = () => {
      const width = frame.getBoundingClientRect().width || HUD_CANVAS_WIDTH;
      setScale(width / HUD_CANVAS_WIDTH);
    };
    updateScale();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateScale);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);

  const guideStyle = { width: HUD_CANVAS_WIDTH, height: HUD_CANVAS_HEIGHT } satisfies CSSProperties;
  const presentationSnapshot = liveSource
    ? hasAcceptedProgramSnapshot(snapshot, connectionState)
      ? snapshot
      : null
    : snapshot;

  return (
    <div className="hud-console__canvas-frame" ref={frameRef}>
      <div
        aria-label="节目 HUD 预览画布"
        className="hud-console__canvas-logical"
        style={{ transform: `scale(${scale})` }}
      >
        {showGrid ? (
          <div className="hud-console__guide hud-console__guide--grid" style={guideStyle} />
        ) : null}
        {showCenter ? (
          <div className="hud-console__guide hud-console__guide--center" style={guideStyle} />
        ) : null}
        {showSafeArea ? (
          <div className="hud-console__guide hud-console__guide--safe" style={guideStyle} />
        ) : null}
        <GameplayHud
          radarClient={radarClient}
          radarSnapshot={radarSnapshot}
          resolvedPreset={resolvedPreset}
          snapshot={presentationSnapshot}
          presentationRevision={presentationRevision}
        />
        <HudEditorOverlay
          mode={editorMode}
          onRadarResizePointerDown={onRadarResizePointerDown}
          onWidgetPointerDown={onWidgetPointerDown}
          resolvedPreset={resolvedPreset}
          selectedWidgetId={selectedWidgetId}
          interactive={editorInteractive}
        />
      </div>
    </div>
  );
}
