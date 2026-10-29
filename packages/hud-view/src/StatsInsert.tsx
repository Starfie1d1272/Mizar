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
  readonly layout?: 'rows' | 'columns' | 'cells' | 'radar';
  readonly recent?: readonly [
    readonly { readonly value: string; readonly sample: string; readonly logo: string | null }[],
    readonly { readonly value: string; readonly sample: string; readonly logo: string | null }[],
  ];
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
        {insert.layout === 'radar' ? (
          <svg
            className="stats-insert__radar"
            viewBox="0 0 900 590"
            role="img"
            aria-label="双方选手七维画像，范围零到一百"
          >
            {[20, 40, 60, 80, 100].map((level) => (
              <polygon
                key={level}
                points={insert.rows.map((_, i) => radarPoint(i, level, 7).join(',')).join(' ')}
                fill="none"
                stroke="#334356"
                strokeWidth="2"
              />
            ))}
            {insert.rows.map((row, i) => (
              <line
                key={row.label}
                x1="450"
                y1="290"
                x2={radarPoint(i, 100, 7)[0]}
                y2={radarPoint(i, 100, 7)[1]}
                stroke="#334356"
              />
            ))}
            {[0, 1].map((side) => (
              <polygon
                key={side}
                points={insert.rows
                  .map((row, i) => radarPoint(i, Number(row.values[side]), 7).join(','))
                  .join(' ')}
                fill={side ? '#c6d7e91c' : '#59a8ff30'}
                stroke={side ? '#c6d7e9' : '#59a8ff'}
                strokeWidth="3"
              />
            ))}
            {insert.rows.map((row, i) => {
              const [x, y] = radarPoint(i, 127, 7);
              return (
                <text
                  key={row.label}
                  x={x}
                  y={y}
                  textAnchor={i === 0 ? 'middle' : i < 4 ? 'start' : 'end'}
                >
                  <tspan x={x}>{row.label}</tspan>
                  <tspan x={x} dy="30" className="stats-insert__radar-values">
                    {row.values[0]} / {row.values[1]}
                  </tspan>
                </text>
              );
            })}
          </svg>
        ) : insert.recent ? (
          <div className="stats-insert__recent">
            {insert.recent.map((items, side) => (
              <section key={side}>
                {items.map((item, i) => (
                  <div className="stats-insert__recent-item" key={i}>
                    {item.logo && <img src={item.logo} alt="" referrerPolicy="no-referrer" />}
                    <strong>{item.value}</strong>
                    <small>{item.sample}</small>
                  </div>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className={`stats-insert__rows stats-insert__rows--${insert.layout ?? 'rows'}`}>
            {insert.rows.map((row, i) => {
              const image = row.artwork ? getMapThumbnail(row.artwork) : null;
              if (insert.layout === 'columns' || insert.layout === 'cells') {
                return (
                  <article className="stats-insert__metric" key={`${row.label}-${i}`}>
                    <h2>{row.label}</h2>
                    <div className="stats-insert__metric-values">
                      {row.values.map((value, side) => (
                        <div key={side}>
                          <span>{insert.teams[side]}</span>
                          <strong>{value}</strong>
                          <small>{row.samples?.[side]}</small>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              }
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
        )}
        <footer>
          <span>{insert.scope}</span>
          <strong>MIZAR</strong>
        </footer>
      </main>
    </ProgramCanvas>
  );
}

function radarPoint(index: number, value: number, count: number): [number, number] {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
  return [450 + (Math.cos(angle) * 205 * value) / 100, 290 + (Math.sin(angle) * 205 * value) / 100];
}
