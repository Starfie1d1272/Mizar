import { useMemo } from 'react';
import { RadarView, type RadarViewSource } from '@mizar/radar-view';
import '@mizar/radar-view/radar.css';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import type { LocalChannelClient } from '../../../realtime';
import type { RadarHudWidgetRendererProps } from '../../hud-renderer-registry';
import { toRadarViewFrame } from './adapter';

export interface RadarProps {
  readonly client?: LocalChannelClient<'radar'> | undefined;
  readonly snapshot?: RadarSnapshot | null | undefined;
  readonly zoomMode?: 'full-map' | 'auto' | undefined;
  readonly presentationRevision?: number | undefined;
}

export function Radar({ client, snapshot, zoomMode, presentationRevision }: RadarProps) {
  const source = useMemo<RadarViewSource | undefined>(() => {
    if (!client) return undefined;
    let last: ReturnType<typeof client.getSnapshot> | undefined;
    let frame: ReturnType<typeof toRadarViewFrame> = null;
    return {
      subscribe: (listener) => client.subscribe(listener),
      getSnapshot: () => {
        const state = client.getSnapshot();
        if (state !== last) {
          last = state;
          frame = toRadarViewFrame(state.state === 'live' ? state.current : null);
        }
        return frame;
      },
    };
  }, [client]);
  const frame = useMemo(() => toRadarViewFrame(snapshot ?? null), [snapshot]);
  return (
    <RadarView
      client={source}
      snapshot={frame}
      zoomMode={zoomMode}
      presentationRevision={presentationRevision}
      assetBaseUrl="/"
      className="radar"
    />
  );
}

export function RadarWidget({
  radarClient,
  radarSnapshot,
  settings,
  presentationRevision,
}: RadarHudWidgetRendererProps) {
  return (
    <Radar
      client={radarClient}
      snapshot={radarSnapshot}
      presentationRevision={presentationRevision}
      zoomMode={settings.settings.zoomMode === 'auto' ? 'auto' : 'full-map'}
    />
  );
}
