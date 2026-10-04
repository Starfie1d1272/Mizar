import { getMapThumbnail } from '@mizar/cs2-assets';
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import { buildMatchHeaderPresentation } from './presentation';

/** Separate layout-owned detail panel; never carried from freeze into live play. */
export function SeriesOverview({ snapshot }: Pick<HudWidgetRendererProps, 'snapshot'>) {
  if (
    snapshot.payload.status.telemetry !== 'fresh' ||
    snapshot.payload.round?.phase !== 'freezetime'
  )
    return null;
  const maps = buildMatchHeaderPresentation(snapshot.payload).seriesMaps;
  if (!maps) return null;
  return (
    <section className="shanghai-series-overview" aria-label="冻结期地图详情">
      {maps.map((map) => {
        const art = getMapThumbnail(map.mapKey);
        return (
          <div className="shanghai-series-detail" key={map.mapOrder}>
            <div
              className="shanghai-series-detail__map"
              style={art ? { backgroundImage: `url("${art.outputPath}")` } : undefined}
            >
              <strong>{map.mapName}</strong>
            </div>
            {map.pickerLogoUrl ? (
              <img src={map.pickerLogoUrl} alt={map.pickerName ?? ''} />
            ) : (
              <span />
            )}
            <strong>
              {map.status === 'current' || map.status === 'completed' ? map.statusText : ''}
            </strong>
          </div>
        );
      })}
    </section>
  );
}
