import { getMapThumbnail, getSideLogo } from '@mizar/cs2-assets';
import type { CSSProperties } from 'react';

import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import { buildMatchHeaderPresentation } from './presentation';

export function SeriesStrip({ snapshot }: HudWidgetRendererProps) {
  const presentation = buildMatchHeaderPresentation(snapshot.payload);
  const maps = presentation.seriesMaps;
  if (maps === null) return null;

  return (
    <section
      aria-label="Series maps"
      className="match-header match-header__series-strip"
      data-match-header-widget="series-strip"
    >
      <div
        className="match-header__series-maps"
        role="list"
        data-series-map-count={maps.length}
        style={{ '--series-map-count': maps.length } as CSSProperties}
      >
        {maps.map((map) => {
          const decider = map.selectionText === 'DECIDER';
          const mapAsset = getMapThumbnail(map.mapKey);
          const sideLogo = map.pickerStartSide === null ? null : getSideLogo(map.pickerStartSide);
          const statusText =
            decider || map.status === 'completed' || map.status === 'current'
              ? decider
                ? 'DECIDER'
                : map.statusText
              : '';
          const outcomeClass =
            map.pickOutcome === null ? '' : ` match-header__series-map--pick-${map.pickOutcome}`;
          return (
            <div
              aria-label={`${map.mapName}${map.pickerName === null ? '' : ` picked by ${map.pickerName}`}${map.pickerStartSide === null ? '' : ` starts ${map.pickerStartSide}`}${statusText ? ` ${statusText}` : ''}`}
              className={`match-header__series-map match-header__series-map--${map.status}${decider ? ' match-header__series-map--decider' : ''}${outcomeClass}`}
              data-map-order={map.mapOrder}
              data-picker={map.picker ?? 'none'}
              data-pick-outcome={map.pickOutcome ?? 'neutral'}
              data-start-side={map.pickerStartSide ?? 'unknown'}
              data-map-status={map.status}
              key={map.mapOrder}
              role="listitem"
            >
              <div className="match-header__series-map-art">
                <div
                  aria-hidden="true"
                  className="match-header__series-map-art-image"
                  style={
                    mapAsset === null
                      ? undefined
                      : { backgroundImage: `url("${mapAsset.outputPath}")` }
                  }
                />
                {map.pickerLogoUrl === null ? null : (
                  <img
                    alt={`${map.pickerName} picked this map`}
                    className="match-header__series-map-picker"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                    src={map.pickerLogoUrl}
                  />
                )}
                {map.pickerStartSide === null ? null : (
                  <span
                    aria-label={`${map.pickerName ?? 'Picker'} starts ${map.pickerStartSide}`}
                    className={`match-header__series-map-start-side match-header__series-map-start-side--${map.pickerStartSide}`}
                    data-side={map.pickerStartSide}
                    style={
                      sideLogo === null
                        ? undefined
                        : ({
                            '--match-header-side-logo': `url("${sideLogo.outputPath}")`,
                          } as CSSProperties)
                    }
                  ></span>
                )}
              </div>
              <span className="match-header__series-map-name" title={map.mapName}>
                {map.mapName}
              </span>
              <strong className="match-header__series-map-status">{statusText}</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}
