import { TeamLogo } from './TeamLogo';
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
  const presentation = buildMatchHeaderPresentation(snapshot.payload);
  const maps = presentation.seriesMaps;
  if (!maps) return null;
  return (
    <section className="shanghai-series-overview" aria-label="冻结期地图详情">
      <div
        className="shanghai-series-detail shanghai-series-detail--heading"
        aria-label="选图、胜方与比分"
      >
        <span />
        <svg aria-label="选图" viewBox="0 0 24 24">
          <path d="M8 12V4a2 2 0 0 1 4 0v6l5 1a3 3 0 0 1 3 3l-1 5H9l-5-6 2-2z" />
        </svg>
        <svg aria-label="胜方" viewBox="0 0 24 24">
          <path d="M7 3h10v8a5 5 0 0 1-4 5v3h4v2H7v-2h4v-3a5 5 0 0 1-4-5zM5 5H2v3q0 5 5 5v-2Q4 11 4 8V7h1zM19 5h3v3q0 5-5 5v-2q3 0 3-3V7h-1z" />
        </svg>
        <svg aria-label="比分" viewBox="0 0 24 24">
          <path d="M5 2h14v20H5z" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M8 6h8M8 10h8M8 14h8M8 18h8" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
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
            {map.pickerName !== null ? (
              <TeamLogo team={{ name: map.pickerName, logoUrl: map.pickerLogoUrl }} fallback />
            ) : (
              <span />
            )}
            {map.winnerName !== null ? (
              <TeamLogo team={{ name: map.winnerName, logoUrl: map.winnerLogoUrl }} fallback />
            ) : (
              <strong>{map.status === 'current' ? map.statusText : ''}</strong>
            )}
            <span>{map.finalScore ? `${map.finalScore.a}:${map.finalScore.b}` : ''}</span>
          </div>
        );
      })}
    </section>
  );
}
