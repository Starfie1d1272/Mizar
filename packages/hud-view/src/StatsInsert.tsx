import { getMapThumbnail } from '@mizar/cs2-assets';
import { BroadcastArc } from './BroadcastArc.js';
import { ProgramCanvas } from './ProgramCanvas.js';
import { useAssetUrl } from './assets.js';
import './broadcast-material.css';
import './stats-insert.css';

export type StatsInsert = {
  readonly title: string;
  readonly subtitle: string;
  readonly scope: string;
  readonly teams: readonly [string, string];
  readonly logos?: readonly [string | null, string | null];
  readonly rows: readonly {
    readonly label: string;
    readonly artwork?: string;
    readonly values: readonly [string, string];
    readonly samples?: readonly [string, string];
    readonly portraits?: readonly [string | null, string | null];
  }[];
};

/** A single, already validated snapshot; the caller owns selection and timing. */
export function StatsInsertView({ insert }: { readonly insert: StatsInsert }) {
  const resolve = useAssetUrl();
  return (
    <ProgramCanvas className="program-scene stats-insert">
      <BroadcastArc />
      <main className="stats-insert__content">
        <header>
          <span>{insert.subtitle}</span>
          <h1>{insert.title}</h1>
        </header>
        <div className="stats-insert__teams">
          <strong>
            {insert.logos?.[0] && <img src={insert.logos[0]} alt="" referrerPolicy="no-referrer" />}
            {insert.teams[0]}
          </strong>
          <span>VS</span>
          <strong>
            {insert.logos?.[1] && <img src={insert.logos[1]} alt="" referrerPolicy="no-referrer" />}
            {insert.teams[1]}
          </strong>
        </div>
        <div className="stats-insert__rows">
          {insert.rows.map((row, i) => {
            const image = row.artwork ? getMapThumbnail(row.artwork) : null;
            return (
              <div className="stats-insert__row" key={`${row.label}-${i}`}>
                <div>
                  {row.portraits?.[0] && (
                    <img
                      className="stats-insert__portrait"
                      src={row.portraits[0]}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <strong>{row.values[0]}</strong>
                  <small>{row.samples?.[0]}</small>
                </div>
                <div className="stats-insert__label">
                  {image && <img src={resolve(image.outputPath)} alt="" />}
                  <span>{row.label}</span>
                </div>
                <div>
                  {row.portraits?.[1] && (
                    <img
                      className="stats-insert__portrait"
                      src={row.portraits[1]}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <strong>{row.values[1]}</strong>
                  <small>{row.samples?.[1]}</small>
                </div>
              </div>
            );
          })}
        </div>
        <footer>
          <span>{insert.scope}</span>
          <strong>MIZAR</strong>
        </footer>
      </main>
    </ProgramCanvas>
  );
}
