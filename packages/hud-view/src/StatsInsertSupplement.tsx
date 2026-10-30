import type { ReactNode, SyntheticEvent } from 'react';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { useAssetUrl } from './assets.js';

type DisplayMetric = {
  readonly label: string;
  readonly value: string;
  readonly width?: number;
  readonly sample?: string;
};
type Person = {
  readonly name: string;
  readonly avatar?: string | null;
  readonly team?: string;
  readonly teamLogo?: string | null;
  readonly sample?: string;
  readonly profileMode?: 'identity' | 'stats' | 'attributes';
  readonly metrics?: readonly DisplayMetric[];
  readonly attributes?: readonly DisplayMetric[];
};
type RosterPlayer = {
  readonly name: string;
  readonly avatar?: string | null;
  readonly values?: readonly string[];
  readonly sample?: string;
};
type Side = {
  readonly name: string;
  readonly logo?: string | null;
  readonly players: readonly RosterPlayer[];
  readonly showStats?: boolean;
};
type MapPhoto = { readonly name: string; readonly artwork: string };
export type StatsInsertSupplement =
  | {
      readonly kind: 'match';
      readonly sides: readonly {
        readonly name: string;
        readonly logo?: string | null;
        readonly records?: readonly { readonly value: string; readonly label: string }[];
      }[];
      readonly center: string;
      readonly badge?: string;
      readonly time?: string;
      readonly format?: string;
      readonly ribbon?: readonly [string, string];
    }
  | { readonly kind: 'maps-info'; readonly maps: readonly MapPhoto[] }
  | { readonly kind: 'lineup'; readonly sides: readonly Side[] }
  | {
      readonly kind: 'recent';
      readonly sides: readonly {
        readonly name: string;
        readonly record?: string;
        readonly matches: readonly {
          readonly stage?: string;
          readonly date?: string;
          readonly opponent: string;
          readonly logo?: string | null;
          readonly score: string;
          readonly maps: readonly { readonly name: string; readonly score: string }[];
        }[];
      }[];
    }
  | {
      readonly kind: 'map-profile';
      readonly maps: readonly (MapPhoto & {
        readonly record: string;
        readonly sample?: string;
        readonly ct?: string;
        readonly t?: string;
        readonly detail?: string;
      })[];
    }
  | {
      readonly kind: 'veto';
      readonly maps: readonly (MapPhoto & {
        readonly sides: readonly {
          readonly name: string;
          readonly values: readonly DisplayMetric[];
        }[];
      })[];
    }
  | {
      readonly kind: 'bp';
      readonly steps: readonly (MapPhoto & {
        readonly order: string;
        readonly action: string;
        readonly actionKind?: 'ban' | 'side_pick';
        readonly team?: string;
        readonly logo?: string | null;
      })[];
    }
  | { readonly kind: 'profile'; readonly person: Person }
  | {
      readonly kind: 'ranking';
      readonly columns: readonly string[];
      readonly players: readonly (RosterPlayer & {
        readonly place: string;
        readonly team?: string;
      })[];
    }
  | {
      readonly kind: 'weapons';
      readonly sides: readonly {
        readonly name: string;
        readonly weapons: readonly {
          readonly name: string;
          readonly kills: string;
          readonly share: string;
          readonly width?: number;
        }[];
      }[];
    }
  | {
      readonly kind: 'community';
      readonly sides: readonly {
        readonly name: string;
        readonly logo?: string | null;
        readonly share: string;
      }[];
    }
  | {
      readonly kind: 'current-map';
      readonly map: MapPhoto;
      readonly score: string;
      readonly columns: readonly string[];
      readonly sides: readonly Side[];
    }
  | {
      readonly kind: 'series';
      readonly maps: readonly (MapPhoto & {
        readonly order: string;
        readonly score: string;
        readonly status: string;
      })[];
    };

function Picture({
  src,
  className,
}: {
  readonly src?: string | null | undefined;
  readonly className?: string | undefined;
}) {
  const hide = (event: SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.style.visibility = 'hidden';
  };
  const show = (event: SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.style.visibility = '';
  };
  return src ? (
    <img
      src={src}
      className={className}
      alt=""
      referrerPolicy="no-referrer"
      onError={hide}
      onLoad={show}
    />
  ) : null;
}

/** Render only presentation facts selected and formatted by the caller. */
export function StatsInsertSupplementView({
  content,
}: {
  readonly content: StatsInsertSupplement;
}) {
  const resolve = useAssetUrl();
  const photo = (map: MapPhoto) => {
    const asset = getMapThumbnail(map.artwork);
    return asset ? resolve(asset.outputPath) : null;
  };
  if (content.kind === 'match')
    return (
      <>
        <div className="stats-match-hero">
          {content.sides
            .map((side, i) => (
              <section className="stats-match-team" key={i}>
                <Picture src={side.logo} />
                <h2>{side.name}</h2>
                {side.records?.map((record, j) => (
                  <p key={j}>
                    <b>{record.value}</b>
                    {record.label}
                  </p>
                ))}
              </section>
            ))
            .reduce<ReactNode[]>((all, team, i) => {
              if (i === 1)
                all.push(
                  <div className="stats-match-vs" key="vs">
                    {content.badge && <div className="stats-match-badge">{content.badge}</div>}
                    <strong>{content.center}</strong>
                    {content.time && <div className="stats-match-time">{content.time}</div>}
                    {content.format && <div>{content.format}</div>}
                  </div>,
                );
              all.push(team);
              return all;
            }, [])}
        </div>
        {content.ribbon && (
          <div className="stats-match-ribbon">
            <span>{content.ribbon[0]}</span>
            <strong>{content.ribbon[1]}</strong>
          </div>
        )}
      </>
    );
  if (content.kind === 'lineup')
    return (
      <div
        className={`stats-rosters stats-full-rosters ${content.sides.length === 1 ? 'single' : ''}`}
      >
        {content.sides.map((side, i) => {
          const hasStats = side.showStats ?? side.players.some((player) => player.values?.length);
          return (
            <section
              className={`stats-roster ${i && content.sides.length > 1 ? 'right' : ''} ${hasStats ? '' : 'identity-only'}`}
              key={i}
            >
              <div className="stats-full-roster-columns">
                <span>{hasStats ? '选手' : ''}</span>
                {hasStats && (
                  <>
                    <span>RATING</span>
                    <span>ADR</span>
                  </>
                )}
              </div>
              {side.players.map((player, j) => (
                <div className="stats-roster-row" key={j}>
                  {player.avatar && (
                    <div className="stats-roster-avatar">
                      <Picture src={player.avatar} />
                    </div>
                  )}
                  <div className="stats-roster-person">
                    <strong>{player.name}</strong>
                    {player.sample && <small>{player.sample}</small>}
                  </div>
                  {hasStats &&
                    [0, 1].map((k) => (
                      <div className="stats-full-roster-stat" key={k}>
                        {player.values?.[k] ?? '—'}
                      </div>
                    ))}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    );
  if (content.kind === 'recent')
    return (
      <div
        className={`stats-original-recent ${content.sides.length === 1 ? 'single' : ''}`}
        data-count={Math.max(0, ...content.sides.map((side) => side.matches.length))}
      >
        {content.sides.map((side, i) => (
          <section key={i}>
            <div className="stats-original-record">
              {side.record && <strong>{side.record}</strong>}
              <span>{side.name}</span>
            </div>
            {side.matches.map((match, j) => (
              <article className="stats-original-match" key={j}>
                <div className="stats-original-top">
                  <span>{match.stage}</span>
                  <span>{match.date}</span>
                </div>
                <div className="stats-original-opponent">
                  <Picture src={match.logo} />
                  <strong>{match.opponent}</strong>
                  <b>{match.score}</b>
                </div>
                <div className="stats-original-maps">
                  {match.maps.map((map, k) => (
                    <span key={k}>
                      {map.name}
                      <b>{map.score}</b>
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    );
  if (content.kind === 'maps-info')
    return (
      <div
        className="stats-maps stats-maps-info"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, content.maps.length)}, minmax(0, 1fr))`,
        }}
      >
        {content.maps.map((map, i) => (
          <article className="stats-map" key={i}>
            <Picture src={photo(map)} />
            <h3>{map.name}</h3>
          </article>
        ))}
      </div>
    );
  if (content.kind === 'map-profile')
    return (
      <div
        className="stats-map-profiles"
        data-count={content.maps.length}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, content.maps.length)}, minmax(0, 1fr))`,
        }}
      >
        {content.maps.map((map, i) => (
          <article className="stats-map-profile" key={i}>
            <Picture className="stats-map-profile-photo" src={photo(map)} />
            <div className="stats-map-profile-title">{map.name}</div>
            <div className="stats-map-profile-record">
              <strong>{map.record}</strong>
              <span>{map.sample}</span>
            </div>
            <div className="stats-map-splits">
              {map.ct != null && (
                <div>
                  <span>CT 胜率</span>
                  <strong>{map.ct}</strong>
                </div>
              )}
              {map.t != null && (
                <div>
                  <span>T 胜率</span>
                  <strong>{map.t}</strong>
                </div>
              )}
            </div>
            {map.detail && <p>{map.detail}</p>}
          </article>
        ))}
      </div>
    );
  if (content.kind === 'veto')
    return (
      <div
        className="stats-veto"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, content.maps.length)}, minmax(0, 1fr))`,
        }}
      >
        {content.maps.map((map, i) => (
          <article className="stats-veto-card" key={i}>
            <Picture src={photo(map)} />
            <h3>{map.name}</h3>
            {map.sides.map((side, n) => (
              <div className="stats-veto-side" key={n}>
                <div>{side.name}</div>
                <div className="stats-veto-values">
                  {side.values.map((item, j) => (
                    <div key={j}>
                      <strong>{item.value}</strong>
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </article>
        ))}
      </div>
    );
  if (content.kind === 'bp') {
    const rows = content.steps.length > 5 ? 2 : 1;
    return (
      <div
        className="stats-bp"
        data-rows={rows}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, Math.ceil(content.steps.length / rows))}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {content.steps.map((step, i) => (
          <article className={`stats-bp-step ${step.actionKind ?? ''}`} key={i}>
            <Picture src={photo(step)} />
            <div className="stats-bp-heading">
              <span>{step.order}</span>
              <h3>{step.name}</h3>
            </div>
            <div className="stats-bp-decision">
              <strong>{step.action}</strong>
              {step.team && (
                <span>
                  <Picture src={step.logo} />
                  {step.team}
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    );
  }
  if (content.kind === 'profile') {
    const p = content.person,
      mode =
        p.profileMode ??
        (p.attributes?.length ? 'attributes' : p.metrics?.length ? 'stats' : 'identity'),
      hasDetails = mode !== 'identity';
    return (
      <div className={`stats-feature ${hasDetails ? '' : 'identity-only'}`}>
        <section className="stats-feature-person">
          <Picture src={p.avatar} />
          <h2>{p.name}</h2>
          <div className="stats-feature-team">
            <Picture src={p.teamLogo} />
            {p.team}
          </div>
          {p.sample && <div className="stats-feature-sample">{p.sample}</div>}
          {mode === 'attributes' && (
            <div className="stats-feature-numbers">
              {p.metrics?.map((item, i) => (
                <div key={i}>
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        {mode === 'attributes' && p.attributes?.length ? (
          <div className="stats-feature-bars">
            {p.attributes.map((item, i) => (
              <div className="stats-feature-row" key={i}>
                <span>{item.label}</span>
                <div>{item.width != null && <i style={{ width: `${item.width}%` }} />}</div>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        ) : mode === 'stats' && p.metrics?.length ? (
          <div className="stats-profile-values">
            {p.metrics.map((item, i) => (
              <div key={i}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (content.kind === 'ranking')
    return (
      <table className="stats-leaderboard">
        <thead>
          <tr>
            <th>选手</th>
            {content.columns.map((column, i) => (
              <th key={i}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {content.players.map((player, i) => (
            <tr key={i}>
              <td>
                <span className="stats-place">{player.place}</span>
                <Picture src={player.avatar} />
                <span className="stats-leader-name">{player.name}</span>
                <span className="stats-leader-team">{player.team}</span>
              </td>
              {player.values?.map((value, j) => (
                <td key={j}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  if (content.kind === 'weapons')
    return (
      <div className={`stats-weapons ${content.sides.length === 1 ? 'single' : ''}`}>
        {content.sides.map((side, i) => (
          <section key={i}>
            <div className="stats-weapon-heading">
              <span>{side.name}</span>
              <span>击杀 / 队内占比</span>
            </div>
            {side.weapons.map((weapon, j) => (
              <div className="stats-weapon" key={j}>
                <span>{weapon.name}</span>
                <div>{weapon.width != null && <i style={{ width: `${weapon.width}%` }} />}</div>
                <strong>{weapon.kills}</strong>
                <b>{weapon.share}</b>
              </div>
            ))}
          </section>
        ))}
      </div>
    );
  if (content.kind === 'community')
    return (
      <div className="stats-community">
        {content.sides.map((side, i) => (
          <section key={i}>
            <Picture src={side.logo} />
            <h2>{side.name}</h2>
            <strong>{side.share}</strong>
          </section>
        ))}
      </div>
    );
  if (content.kind === 'current-map')
    return (
      <>
        <div className="stats-summary-map">
          <Picture src={photo(content.map)} />
          <strong>{content.map.name}</strong>
          <div>{content.score}</div>
        </div>
        <div className="stats-rosters stats-summary-rosters">
          {content.sides.map((side, i) => (
            <section className={`stats-roster ${i ? 'right' : ''}`} key={i}>
              <div className="stats-summary-columns">
                <span>{side.name}</span>
                {content.columns.map((column, j) => (
                  <span key={j}>{column}</span>
                ))}
              </div>
              {side.players.map((player, j) => (
                <div className="stats-roster-row" key={j}>
                  {player.avatar && (
                    <div className="stats-roster-avatar">
                      <Picture src={player.avatar} />
                    </div>
                  )}
                  <div className="stats-roster-person">
                    <strong>{player.name}</strong>
                  </div>
                  {player.values?.map((value, k) => (
                    <div className="stats-summary-stat" key={k}>
                      {value}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
      </>
    );
  return (
    <div
      className="stats-series"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, content.maps.length)}, minmax(0, 1fr))` }}
    >
      {content.maps.map((map, i) => (
        <article key={i}>
          <Picture src={photo(map)} />
          <span>{map.order}</span>
          <h3>{map.name}</h3>
          <strong>{map.score}</strong>
          <p>{map.status}</p>
        </article>
      ))}
    </div>
  );
}
