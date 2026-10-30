import { Fragment, type CSSProperties, type SyntheticEvent } from 'react';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { BroadcastArc } from './BroadcastArc.js';
import { StatsInsertSupplementView, type StatsInsertSupplement } from './StatsInsertSupplement.js';
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
  readonly unit?: string;
  readonly artwork?: string;
  readonly values: Pair<string>;
  readonly numericValues?: Pair<number | null>;
  readonly barWidths?: Pair<number | null>;
  readonly samples?: Pair<string>;
  readonly portraits?: Pair<string | null>;
};
export type StatsInsert = {
  readonly content?: StatsInsertSupplement;
  readonly event?: string;
  readonly stage?: string;
  readonly phaseFormat?: string;
  readonly pageCount?: string;
  readonly rail?: Pair<string>;
  readonly railCenter?: string;
  readonly visibleSides?: readonly (0 | 1)[];
  readonly playerSamples?: Pair<string>;
  readonly radarMode?: 'radar' | 'bars';
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
  const sides = insert.visibleSides ?? ([0, 1] as const);
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
          <span className="stats-top-center">{insert.phaseFormat}</span>
          <span>{matchTeams[1]}</span>
        </div>
        {insert.content?.kind !== 'match' && (
          <header className="stats-heading">
            <div>
              <p>{insert.subtitle}</p>
              <h1>{insert.title}</h1>
            </div>
            <div className="stats-logos">
              {sides.map((side, index) => (
                <span className="stats-heading-logo" key={side}>
                  {index > 0 && matchLogos?.[sides[0]!] && matchLogos?.[side] && <span>VS</span>}
                  <Picture src={matchLogos?.[side]} />
                </span>
              ))}
            </div>
          </header>
        )}
        {insert.content?.kind !== 'match' && (
          <div className="stats-rail">
            <span>
              {insert.rail
                ? insert.rail[0]
                : insert.layout === 'maps'
                  ? `上排 · ${matchTeams[0]}`
                  : insert.layout === 'radar'
                    ? '七维 · 0–100'
                    : insert.teams[0]}
            </span>
            <span className="stats-rail-center">{insert.railCenter}</span>
            <span>
              {insert.rail
                ? insert.rail[1]
                : insert.layout === 'maps'
                  ? `下排 · ${matchTeams[1]}`
                  : insert.layout === 'radar'
                    ? '历史基准'
                    : insert.teams[1]}
            </span>
          </div>
        )}
        <main className="stats-body">
          {insert.content ? (
            <StatsInsertSupplementView content={insert.content} />
          ) : insert.layout === 'maps' ? (
            <div
              className={`stats-maps ${sides.length === 1 ? 'single' : ''}`}
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
                  {sides.map((side) => {
                    const value = row.values[side];
                    return (
                      <div
                        className={`stats-map-number ${value === '—' ? 'missing' : ''}`}
                        key={side}
                      >
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
                    );
                  })}
                </article>
              ))}
            </div>
          ) : insert.recent ? (
            <div
              className={`stats-recent ${sides.length === 1 ? 'single' : ''}`}
              data-count={Math.max(...insert.recent.map((items) => items.length))}
            >
              {sides.map((side) => (
                <section key={side}>
                  <div className="stats-recent-team">{matchTeams[side]}</div>
                  {insert.recent![side].map((item, i) => (
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
            <div className={`stats-rosters ${sides.length === 1 ? 'single' : ''}`}>
              {sides.map((side, index) => (
                <section
                  className={`stats-roster ${index && sides.length > 1 ? 'right' : ''}`}
                  key={side}
                >
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
            <div className={`stats-players ${sides.length === 1 ? 'single' : ''}`}>
              {sides.map((side, index) => (
                <Fragment key={side}>
                  {index > 0 && <div className="stats-versus">VS</div>}
                  <PlayerSide insert={insert} side={side} />
                </Fragment>
              ))}
            </div>
          ) : insert.layout === 'radar' && sides.length === 1 ? (
            <StatsInsertSupplementView
              content={{
                kind: 'profile',
                person: {
                  name: insert.teams[sides[0]!],
                  avatar: insert.logos?.[sides[0]!] ?? null,
                  team: matchTeams[sides[0]!],
                  sample: insert.rows[0]?.samples?.[sides[0]!] ?? '',
                  metrics: (['rating', 'adr'] as const).flatMap((key) => {
                    const value = insert.playerMetrics?.[sides[0]!]?.[key];
                    return value == null
                      ? []
                      : [{ label: key === 'rating' ? 'Rating' : 'ADR', value }];
                  }),
                  attributes: insert.rows.flatMap((row) => {
                    const value = row.numericValues?.[sides[0]!];
                    return value == null
                      ? []
                      : [{ label: row.label, value: row.values[sides[0]!], width: value }];
                  }),
                },
              }}
            />
          ) : insert.layout === 'radar' ? (
            <div className="stats-radar-layout">
              <RadarPerson insert={insert} side={0} />
              <Radar rows={insert.rows} mode={insert.radarMode} />
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
                  {sides.map((side) => (
                    <div className="stats-column-block" key={side}>
                      <span>{insert.teams[side]}</span>
                      <strong>{row.values[side]}</strong>
                      <small>{row.samples?.[side]}</small>
                      {row.numericValues?.[side] != null && (
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
            <div className="stats-cells" data-count={insert.rows.length}>
              {insert.rows.map((row, i) => (
                <article className="stats-cell" key={i}>
                  <h3>{row.label}</h3>
                  <div>
                    {sides.map((side, index) => (
                      <div key={side}>
                        {index === 1 && <span className="stats-cell-vs">VS</span>}
                        <strong>{row.values[side]}</strong>
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
                <div
                  className={`stats-comparison-row ${sides.length === 1 ? 'single' : ''}`}
                  key={i}
                >
                  {sides.length > 1 && <CompareValue row={row} side={sides[0]!} />}
                  <div className="stats-metric-name">
                    {row.label}
                    {row.unit && <small>{row.unit}</small>}
                  </div>
                  {sides.length > 0 && <CompareValue row={row} side={sides[sides.length - 1]!} />}
                </div>
              ))}
            </div>
          )}
        </main>
        <footer className="stats-footer">
          <div>
            <strong>{insert.event}</strong>
            <span>{insert.stage}</span>
            <span>{insert.scope}</span>
          </div>
          <div>
            {insert.pageCount && <span className="stats-footer-page">{insert.pageCount}</span>}
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
    <div className={`stats-compare-value ${row.values[side] === '—' ? 'missing' : ''}`}>
      <strong>{row.values[side]}</strong>
      <span>{row.samples?.[side]}</span>
      {(row.barWidths?.[side] ?? row.numericValues?.[side]) != null && (
        <div>
          <i
            style={{
              width: `${Math.max(0, Math.min(100, (row.barWidths?.[side] ?? row.numericValues?.[side])!))}%`,
            }}
          />
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
            {insert.playerSamples?.[side] ??
              insert.rows
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
      <div className="stats-radar-values">
        {(['rating', 'adr'] as const).map((key) => (
          <div key={key}>
            <strong>{insert.playerMetrics?.[side]?.[key] ?? '—'}</strong>
            <span>{key === 'rating' ? 'Rating' : 'ADR'}</span>
          </div>
        ))}
      </div>
      <small>{insert.rows[0]?.samples?.[side]}</small>
    </div>
  );
}
function radarPoint(index: number, value: number, count: number): [number, number] {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
  return [400 + (Math.cos(angle) * 212 * value) / 100, 284 + (Math.sin(angle) * 212 * value) / 100];
}
function Radar({
  rows,
  mode,
}: {
  readonly rows: readonly Row[];
  readonly mode?: 'radar' | 'bars' | undefined;
}) {
  const complete =
    mode !== 'bars' &&
    rows.length > 0 &&
    rows.every((row) => row.numericValues?.every((value) => value != null));
  if (!complete)
    return (
      <div className="stats-attribute-comparison">
        {rows.map((row, i) => (
          <div className="stats-attribute-pair" key={i}>
            <span>{row.label}</span>
            <strong>{row.values[0]}</strong>
            <div className="stats-attribute-dual-bars">
              {([0, 1] as const).map((side) => {
                const value = row.numericValues?.[side];
                return value == null ? null : (
                  <i
                    key={side}
                    className={side ? 'right' : 'left'}
                    style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                  />
                );
              })}
            </div>
            <strong>{row.values[1]}</strong>
          </div>
        ))}
      </div>
    );
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
      {complete &&
        ([0, 1] as const).map((side) => (
          <polygon
            key={side}
            points={rows
              .map((row, i) => radarPoint(i, row.numericValues![side]!, rows.length).join(','))
              .join(' ')}
            fill={side ? '#c6d7e90f' : '#59a8ff26'}
            stroke={
              side
                ? '#c6d7e9'
                : 'rgb(from var(--mizar-broadcast-pulse-blue) calc(r + 44) calc(g + 41) calc(b + 6) / alpha)'
            }
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
              <tspan fill="rgb(from var(--mizar-broadcast-pulse-blue) calc(r + 44) calc(g + 41) calc(b + 6) / alpha)">
                {row.values[0]}
              </tspan>
              <tspan fill="#667d95"> / </tspan>
              <tspan fill="#dbe7f5">{row.values[1]}</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
