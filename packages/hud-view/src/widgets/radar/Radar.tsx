import { useAssetUrl } from '../../assets.js';
import { hudDesignForVariant } from '../../hud-design.js';
import { useMemo } from 'react';
import { RadarView, type RadarViewSource } from '@mizar-hud/radar-view';
import '@mizar-hud/radar-view/radar.css';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import type { RadarHudWidgetRendererProps } from '../../hud-renderer-registry.js';
import { toRadarViewFrame } from './adapter.js';

export interface RadarProps {
  readonly appearance?: 'default' | 'shanghai' | 'esl';
  readonly source?: RadarViewSource | undefined;
  readonly snapshot?: RadarSnapshot | null | undefined;
  readonly staticFrame?: boolean | undefined;
  readonly zoomMode?: 'full-map' | 'auto' | undefined;
  readonly presentationRevision?: number | undefined;
}

export function Radar({
  source,
  staticFrame = false,
  snapshot,
  zoomMode,
  presentationRevision,
  appearance = 'default',
}: RadarProps) {
  const resolveAssetUrl = useAssetUrl();
  const frame = useMemo(() => toRadarViewFrame(snapshot ?? null), [snapshot]);
  return (
    <RadarView
      staticFrame={staticFrame}
      appearance={appearance}
      client={source}
      snapshot={frame}
      zoomMode={zoomMode}
      presentationRevision={presentationRevision}
      assetBaseUrl="/"
      resolveAssetUrl={resolveAssetUrl}
      className="radar"
    />
  );
}

export function RadarWidget({
  radarSource,
  staticFrame,
  radarSnapshot,
  settings,
  presentationRevision,
}: RadarHudWidgetRendererProps) {
  return (
    <Radar
      staticFrame={staticFrame}
      appearance={
        hudDesignForVariant(settings.variant) === 'perfectworld'
          ? 'shanghai'
          : hudDesignForVariant(settings.variant) === 'esl'
            ? 'esl'
            : 'default'
      }
      source={radarSource}
      snapshot={radarSnapshot}
      presentationRevision={presentationRevision}
      zoomMode={settings.settings.zoomMode === 'auto' ? 'auto' : 'full-map'}
    />
  );
}
