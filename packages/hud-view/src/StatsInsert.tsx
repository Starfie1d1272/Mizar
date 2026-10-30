import type { CSSProperties, SyntheticEvent } from 'react';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { BroadcastArc } from './BroadcastArc.js';
import { ProgramCanvas } from './ProgramCanvas.js';
import { useAssetUrl } from './assets.js';
import './broadcast-material.css';
import './stats-insert.css';

function hideBrokenImage(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.visibility = 'hidden';
}
function showLoadedImage(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.visibility = '';
}

type Pair<T> = readonly [T, T];
type Row = {
  readonly label: string;
  readonly artwork?: string;
  readonly values: Pair<string>;
  readonly numericValues?: Pair<number>;
  readonly samples?: Pair<string>;
  readonly portraits?: Pair<string | null>;
};
export type StatsInsert = {
  readonly title: string;
  readonly subtitle: string;
  readonly scope: string;
  readonly teams: Pair<string>;
  readonly logos?: Pair<string | null>;
  readonly matchTeams?: Pair<string>;
  readonly matchLogos?: Pair<string | null>;
  readonly playerMetrics?: readonly {
    readonly rating?: string | undefined;
    readonly adr?: string | undefined;
  }[];
  readonly layout?:
    | 'rows'
    | 'maps'
    | 'recent'
    | 'columns'
    | 'comparison'
    | 'cells'
    | 'lineups'
    | 'players'
    | 'radar';
  readonly recent?: Pair<
    readonly {
      readonly value: string;
      readonly opponent?: string;
      readonly date?: string;
      readonly sample: string;
      readonly logo: string | null;
    }[]
  >;
  readonly rows: readonly Row[];
};

function Picture({
  src,
  className,
}: {
  readonly src?: string | null | undefined;
  readonly className?: string;
}) {
  return src ? (
    <img
      className={className}
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={hideBrokenImage}
      onLoad={showLoadedImage}
    />
  ) : null;
}

/** The caller owns selection, statistical calculations and timing. */
export function StatsInsertView({
  insert,
  sceneStyle,
}: {
  readonly insert: StatsInsert;
  readonly sceneStyle?: CSSProperties | undefined;
}) {
  const resolve = useAssetUrl();
  const matchTeams = insert.matchTeams ?? insert.teams;
  const matchLogos = insert.matchLogos ?? insert.logos;
  const mapAsset = (name?: string) => {
    const map = name ? getMapThumbnail(name) : null;
    return map ? resolve(map.outputPath) : null;
  };
  return (
    <div style={{ display: 'contents', ...sceneStyle }}>
      <ProgramCanvas className="program-scene stats-insert">
        <BroadcastArc />
        <div className="stats-top">
          <span>{matchTeams[0]}</span>
          <span />
          <span>{matchTeams[1]}</span>
        </div>
        <header className="stats-heading">
          <div>
            <p>{insert.subtitle}</p>
            <h1>{insert.title}</h1>
          </div>
          <div className="stats-logos">
            <Picture src={matchLogos?.[0]} />
            {matchLogos?.[0] && matchLogos?.[1] && <span>VS</span>}
            <Picture src={matchLogos?.[1]} />
          </div>
        </header>
        <div className="stats-rail">
          <span>
            {insert.layout === 'maps'
              ? `上排 · ${matchTeams[0]}`
              : insert.layout === 'radar'
                ? '七维 · 0–100'
                : insert.teams[0]}
          </span>
          <span>
            {insert.layout === 'maps'
              ? `下排 · ${matchTeams[1]}`
              : insert.layout === 'radar'
                ? '历史基准'
                : insert.teams[1]}
          </span>
        </div>
        <main className="stats-body">
          {insert.layout === 'maps' ? (
            <div
              className="stats-maps"
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, insert.rows.length)}, minmax(0, 1fr))`,
              }}
            >
              {insert.rows.map((row, i) => (
                <article className="stats-map" key={i}>
                  <div className="stats-map-photo">
                    <Picture src={mapAsset(row.artwork)} />
                  </div>
                  <h3>{row.label}</h3>
                  {row.values.map((value, side) => (
                    <div className="stats-map-number" key={side}>
                      <strong>
                        {value.endsWith('%') ? (
                          <>
                            {value.slice(0, -1)}
                            <sup>%</sup>
                          </>
                        ) : (
                          value
                        )}
                      </strong>
                      <small>{row.samples?.[side]}</small>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          ) : insert.recent ? (
            <div
              className="stats-recent"
              data-count={Math.max(...insert.recent.map((items) => items.length))}
            >
              {insert.recent.map((items, side) => (
                <section key={side}>
                  <div className="stats-recent-team">{matchTeams[side]}</div>
                  {items.map((item, i) => (
                    <article className="stats-recent-match" key={i}>
                      <div className="stats-recent-top">
                        <span>单图</span>
                        <span>{item.date}</span>
                      </div>
                      <div className="stats-recent-opponent">
                        <Picture src={item.logo} />
                        <strong>{item.opponent}</strong>
                        <b>{item.value}</b>
                      </div>
                      <div className="stats-recent-map">{item.sample}</div>
                    </article>
                  ))}
                </section>
              ))}
            </div>
          ) : insert.layout === 'lineups' ? (
            <div className="stats-rosters">
              {([0, 1] as const).map((side) => (
                <section className={`stats-roster ${side ? 'right' : ''}`} key={side}>
                  <div className="stats-roster-columns" />
                  {insert.rows.map((row, i) => (
                    <div className="stats-roster-row" key={i}>
                      {row.portraits?.[side] && (
                        <div className="stats-roster-avatar">
                          <Picture src={row.portraits[side]} />
                        </div>
                      )}
                      <div className="stats-roster-person">
                        <strong>{row.values[side]}</strong>
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : insert.layout === 'players' ? (
            <div className="stats-players">
              <PlayerSide insert={insert} side={0} />
              <div className="stats-versus">VS</div>
              <PlayerSide insert={insert} side={1} />
            </div>
          ) : insert.layout === 'radar' ? (
            <div className="stats-radar-layout">
              <RadarPerson insert={insert} side={0} />
              <Radar rows={insert.rows} />
              <RadarPerson insert={insert} side={1} />
              <div className="stats-radar-key">
                <span>
                  <i />
                  {insert.teams[0]}
                </span>
                <span>
                  <i />
                  {insert.teams[1]}
                </span>
              </div>
            </div>
          ) : insert.layout === 'columns' ? (
            <div
              className="stats-columns"
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, insert.rows.length)}, minmax(0, 1fr))`,
              }}
            >
              {insert.rows.map((row, i) => (
                <article className="stats-column" key={i}>
                  <h3>{row.label}</h3>
                  {row.values.map((value, side) => (
                    <div className="stats-column-block" key={side}>
                      <span>{insert.teams[side]}</span>
                      <strong>{value}</strong>
                      <small>{row.samples?.[side]}</small>
                      {row.numericValues && (
                        <div className="stats-mini-bar">
                          <i
                            style={{
                              width: `${Math.max(0, Math.min(100, row.numericValues[side]!))}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </article>
              ))}
            </div>
          ) : insert.layout === 'cells' ? (
            <div className="stats-cells">
              {insert.rows.map((row, i) => (
                <article className="stats-cell" key={i}>
                  <h3>{row.label}</h3>
                  <div>
                    {row.values.map((value, side) => (
                      <div key={side}>
                        {side === 1 && <span className="stats-cell-vs">VS</span>}
                        <strong>{value}</strong>
                        <span>{row.samples?.[side]}</span>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="stats-comparison">
              {insert.rows.map((row, i) => (
                <div className="stats-comparison-row" key={i}>
                  <CompareValue row={row} side={0} />
                  <div className="stats-metric-name">{row.label}</div>
                  <CompareValue row={row} side={1} />
                </div>
              ))}
            </div>
          )}
        </main>
        <footer className="stats-footer">
          <div>
            <span>{insert.scope}</span>
          </div>
          <div>
            <Picture src={resolve('/brand/mizar-mark-mono.svg')} />
            <span>MIZAR</span>
          </div>
        </footer>
      </ProgramCanvas>
    </div>
  );
}
function CompareValue({ row, side }: { readonly row: Row; readonly side: 0 | 1 }) {
  return (
    <div className="stats-compare-value">
      <strong>{row.values[side]}</strong>
      <span>{row.samples?.[side]}</span>
      {row.numericValues && (
        <div>
          <i style={{ width: `${Math.max(0, Math.min(100, row.numericValues[side]))}%` }} />
        </div>
      )}
    </div>
  );
}
function PlayerSide({ insert, side }: { readonly insert: StatsInsert; readonly side: 0 | 1 }) {
  return (
    <section className="stats-player-side">
      <div className={`stats-player-identity ${insert.logos?.[side] ? '' : 'no-avatar'}`}>
        <Picture src={insert.logos?.[side]} />
        <div>
          <h2>{insert.teams[side]}</h2>
          <p>{insert.matchTeams?.[side]}</p>
          <small>
            {insert.rows
              .map((row) => row.samples?.[side])
              .filter(Boolean)
              .join(' · ')}
          </small>
        </div>
      </div>
      <div className="stats-player-grid">
        {insert.rows.map((row, i) => (
          <div className="stats-player-stat" key={i}>
            <span>{row.label}</span>
            <strong>{row.values[side]}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
function RadarPerson({ insert, side }: { readonly insert: StatsInsert; readonly side: 0 | 1 }) {
  return (
    <div className="stats-radar-person">
      <Picture src={insert.logos?.[side]} />
      <h2>{insert.teams[side]}</h2>
      <div>{insert.matchTeams?.[side]}</div>
      {insert.playerMetrics?.[side] && (
        <div className="stats-radar-values">
          {(['rating', 'adr'] as const).map((key) => {
            const value = insert.playerMetrics?.[side]?.[key];
            return value == null ? null : (
              <div key={key}>
                <strong>{value}</strong>
                <span>{key === 'rating' ? 'Rating' : 'ADR'}</span>
              </div>
            );
          })}
        </div>
      )}
      <small>{insert.rows[0]?.samples?.[side]}</small>
    </div>
  );
}
function radarPoint(index: number, value: number, count: number): [number, number] {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
  return [400 + (Math.cos(angle) * 212 * value) / 100, 284 + (Math.sin(angle) * 212 * value) / 100];
}
function Radar({ rows }: { readonly rows: readonly Row[] }) {
  return (
    <svg
      className="stats-radar"
      viewBox="0 0 800 590"
      role="img"
      aria-label="双方选手画像，范围零到一百"
    >
      {[20, 40, 60, 80, 100].map((level) => (
        <polygon
          key={level}
          points={rows.map((_, i) => radarPoint(i, level, rows.length).join(',')).join(' ')}
          fill="none"
          stroke="#334356"
          strokeWidth={level === 100 ? 2 : 1}
        />
      ))}
      {rows.map((row, i) => {
        const [x, y] = radarPoint(i, 100, rows.length);
        return <line key={row.label} x1="400" y1="284" x2={x} y2={y} stroke="#28384b" />;
      })}
      {rows.every((row) => row.numericValues) &&
        ([0, 1] as const).map((side) => (
          <polygon
            key={side}
            points={rows
              .map((row, i) => radarPoint(i, row.numericValues![side], rows.length).join(','))
              .join(' ')}
            fill={side ? '#c6d7e90f' : '#59a8ff26'}
            stroke={side ? '#c6d7e9' : 'var(--mizar-broadcast-pulse-blue)'}
            strokeWidth="3"
          />
        ))}
      {rows.map((row, i) => {
        const [x, y] = radarPoint(i, 123, rows.length);
        return (
          <g key={row.label} textAnchor={i === 0 ? 'middle' : i < 4 ? 'start' : 'end'}>
            <text x={x} y={y - 7}>
              {row.label}
            </text>
            <text x={x} y={y + 23} className="stats-radar-score">
              <tspan fill="var(--mizar-broadcast-pulse-blue)">{row.values[0]}</tspan>
              <tspan fill="#667d95"> / </tspan>
              <tspan fill="#dbe7f5">{row.values[1]}</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
