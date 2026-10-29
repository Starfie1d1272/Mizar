import { assetCssUrl, useAssetUrl } from './assets.js';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { getMapThumbnail } from '@mizar/cs2-assets';
import type { HudResolvedPreset } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import type {
  ProgramPresentation,
  ProgramSceneId,
  ProgramSceneState,
} from '@mizar/protocol/program-scenes';
import { ProgramCanvas } from './ProgramCanvas.js';
import { GameplayHud } from './GameplayHud.js';
import { BroadcastArc } from './BroadcastArc.js';
import './program-scenes.css';
import './broadcast-material.css';

function Media({
  src,
  className = '',
  fallback = '',
}: {
  src: string | null | undefined;
  className?: string;
  fallback?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return src && failed !== src ? (
    <img
      className={className}
      src={src}
      alt=""
      onLoad={(event) => {
        const img = event.currentTarget;
        img.dataset.shape = img.naturalWidth / img.naturalHeight > 1.7 ? 'wide' : 'square';
      }}
      onError={() => setFailed(src)}
    />
  ) : fallback ? (
    <span className={`${className} scene-media-fallback`} aria-hidden="true">
      {fallback}
    </span>
  ) : null;
}
const teamInitials = (name: string) => {
  const words = name.trim().split(/\s+/);
  return words.length > 1
    ? words
        .slice(0, 2)
        .map((word) => word[0])
        .join('')
        .toUpperCase()
    : name.slice(0, 2);
};
const mapName = (value: string) => value.replace(/^de_/, '').toUpperCase();
const number = (value: number | null | undefined) => value ?? '—';
const scheduleTime = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value)) + ' · UTC+8';

function BroadcastIdentity({ data }: { data: ProgramPresentation }) {
  const resolveAssetUrl = useAssetUrl();
  return (
    <footer className="broadcast-identity">
      <div>
        <Media src={data.eventLogoUrl} />
        <strong>{data.match?.competition?.name}</strong>
        <span>{data.match?.stage}</span>
      </div>
      <div className="broadcast-signature">
        <img src={resolveAssetUrl('/brand/mizar-mark-mono.svg')} alt="" />
        <span>MIZAR</span>
      </div>
    </footer>
  );
}

function MapStrip({ data }: { data: ProgramPresentation }) {
  const resolveAssetUrl = useAssetUrl();
  const series = data.series;
  if (!series) return null;
  return (
    <div className="summary-map-strip">
      <Media src={series.entrants.a.logoUrl} className="summary-entrant-logo" />
      <div className="summary-map-cards">
        {series.maps.map((map) => {
          const picker =
            map.selection.kind === 'pick'
              ? Object.values(series.entrants).find(
                  (entrant) =>
                    map.selection.kind === 'pick' && entrant.entryId === map.selection.entryId,
                )?.name
              : null;
          const asset = getMapThumbnail(map.mapName);
          return (
            <article key={map.mapOrder} className={`summary-map summary-map--${map.status}`}>
              <div className="summary-map-tab">{mapName(map.mapName)}</div>
              <div className="summary-map-art">
                {asset ? <img src={resolveAssetUrl(asset.outputPath)} alt="" /> : null}
                <div className="summary-map-pick">
                  {picker ? `${picker} PICK` : map.selection.kind === 'decider' ? 'DECIDER' : '—'}
                </div>
                <strong>
                  {map.status === 'completed'
                    ? `${number(map.finalScore?.a)} – ${number(map.finalScore?.b)}`
                    : map.status === 'current' && data.halftime?.mapOrder === map.mapOrder
                      ? `${number(data.halftime.score.a)} – ${number(data.halftime.score.b)}`
                      : ''}
                </strong>
                <span className="summary-map-state">
                  {map.status === 'current'
                    ? 'CURRENT'
                    : map.status === 'not_played'
                      ? 'NOT PLAYED'
                      : `MAP ${map.mapOrder}`}
                </span>
              </div>
            </article>
          );
        })}
      </div>
      <Media src={series.entrants.b.logoUrl} className="summary-entrant-logo" />
    </div>
  );
}
function SummaryBoard({ data, scene }: { data: ProgramPresentation; scene: ProgramSceneId }) {
  const summary = summaryForScene(data, scene);
  const hasPlayers = Boolean(summary && (summary.players.a.length || summary.players.b.length));
  return (
    <>
      <MapStrip data={data} />
      <div className="summary-caption">
        <span>
          {scene === 'halftime'
            ? 'HALFTIME'
            : scene === 'match_result'
              ? data.series?.status === 'completed'
                ? 'MATCH COMPLETE'
                : 'MATCH RESULT PENDING'
              : 'BETWEEN MAPS'}
        </span>
        <strong>
          {summary
            ? `${mapName(summary.mapName)} · ${number(summary.score.a)} : ${number(summary.score.b)}`
            : scene === 'halftime'
              ? 'HALFTIME DATA PENDING'
              : 'MAP DATA PENDING'}
        </strong>
        <span>{scene === 'match_result' ? 'FINAL MAP STATS' : 'MAP STATS'}</span>
      </div>
      {hasPlayers ? (
        <div className="summary-stat-axis" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i}>K/D</span>
          ))}
        </div>
      ) : null}
      <div className="summary-players">
        {(['a', 'b'] as const).map((side) => (
          <div className={`summary-side summary-side--${side}`} key={side}>
            {(summary?.players[side] ?? []).map((player) => (
              <div className="summary-player" key={player.id}>
                <div className="summary-avatar">
                  <Media src={player.avatarUrl} fallback={(player.name ?? '?').slice(0, 1)} />
                </div>
                <strong className="summary-player-name">{player.name ?? 'UNKNOWN PLAYER'}</strong>
                <div className="summary-player-stats" aria-label="Kills / Deaths">
                  <span>{number(player.kills)}</span>
                  <span className="summary-stat-separator" aria-hidden="true">
                    –
                  </span>
                  <span>{number(player.deaths)}</span>
                </div>
              </div>
            ))}
            {!summary || summary.players[side].length === 0 ? (
              <p className="summary-unavailable">STATS UNAVAILABLE</p>
            ) : null}
          </div>
        ))}
      </div>
      {data.series ? (
        <footer className="summary-footer">
          <strong
            data-winner={
              data.series.status === 'completed' &&
              data.series.score.a !== null &&
              data.series.score.b !== null &&
              data.series.score.a >= data.series.requiredWins &&
              data.series.score.a > data.series.score.b
            }
          >
            {data.series.entrants.a.name}
          </strong>
          <span>
            {data.series.score.a ?? '—'} : {data.series.score.b ?? '—'}
          </span>
          <strong
            data-winner={
              data.series.status === 'completed' &&
              data.series.score.a !== null &&
              data.series.score.b !== null &&
              data.series.score.b >= data.series.requiredWins &&
              data.series.score.b > data.series.score.a
            }
          >
            {data.series.entrants.b.name}
          </strong>
        </footer>
      ) : null}
    </>
  );
}
function Waiting({ data }: { data: ProgramPresentation }) {
  const series = data.series;
  return (
    <main className="waiting-layout" data-schedule={Boolean(data.previous || data.next)}>
      <header className="waiting-event">
        <Media src={data.eventLogoUrl} />
        <span>{data.match?.competition?.name ?? ''}</span>
      </header>
      {series ? (
        <>
          <p className="waiting-label">
            COMING UP{' '}
            <span>
              {data.match?.stage} · {series.format.toUpperCase()}
            </span>
          </p>
          <div className="waiting-hero">
            {(['a', 'b'] as const).map((side) => (
              <div className={`waiting-team waiting-team--${side}`} key={side}>
                {series.entrants[side].logoUrl ? (
                  <div className="waiting-emblem">
                    <Media src={series.entrants[side].logoUrl} />
                  </div>
                ) : null}
                <strong>{series.entrants[side].name}</strong>
              </div>
            ))}
            <span className="waiting-vs">VS</span>
          </div>
          {data.scheduledAt ? (
            <p className="waiting-time">
              SCHEDULED <strong>{scheduleTime(data.scheduledAt)}</strong>
            </p>
          ) : null}
        </>
      ) : (
        <h1 className="waiting-neutral">BROADCAST STARTING SOON</h1>
      )}
      <div className="waiting-schedule">
        {(['next', 'previous'] as const).map((kind) => {
          const card = data[kind];
          return card ? (
            <article className={`waiting-schedule--${kind}`} key={kind}>
              <small>{kind === 'next' ? 'UP NEXT' : 'PREVIOUS MATCH'}</small>
              <strong>
                <span className="waiting-schedule-team">{card.a}</span>
                <span>{card.score ?? 'VS'}</span>
                <span className="waiting-schedule-team">{card.b}</span>
              </strong>
              <p>
                {card.stage} · {card.format.toUpperCase()}
                {card.scheduledAt ? ` · ${scheduleTime(card.scheduledAt)}` : ''}
              </p>
            </article>
          ) : null;
        })}
      </div>
    </main>
  );
}
function MapResult({ data }: { data: ProgramPresentation }) {
  const resolveAssetUrl = useAssetUrl();
  const summary = summaryForScene(data, 'map_result');
  const series = data.series;
  return summary && series ? (
    <main className="result-sting">
      {getMapThumbnail(summary.mapName) ? (
        <img
          className="result-backdrop"
          src={resolveAssetUrl(getMapThumbnail(summary.mapName)!.outputPath)}
          alt=""
        />
      ) : null}
      <h1>MAP {summary.mapOrder}</h1>
      <p className="result-map-name">{mapName(summary.mapName)}</p>
      <span className="result-vs">VS</span>
      {(['a', 'b'] as const).map((side) => (
        <div
          className={`result-side result-side--${side}`}
          key={side}
          data-winner={
            summary.score[side] !== null &&
            summary.score[side === 'a' ? 'b' : 'a'] !== null &&
            summary.score[side] > summary.score[side === 'a' ? 'b' : 'a']!
          }
        >
          <strong className="result-round-score">{number(summary.score[side])}</strong>
          <div className="result-logo">
            <Media
              src={series.entrants[side].logoUrl}
              fallback={teamInitials(series.entrants[side].name)}
            />
          </div>
          <span className="result-series-score">{series.score[side] ?? '—'}</span>
          <strong className="result-team-name">{series.entrants[side].name}</strong>
        </div>
      ))}
    </main>
  ) : (
    <main className="waiting-layout">
      <h1 className="waiting-neutral">MAP RESULT PENDING</h1>
    </main>
  );
}
function summaryForScene(data: ProgramPresentation, scene: ProgramSceneId) {
  if (scene === 'halftime') return data.halftime;
  const snapshot = data.completed.at(-1);
  if (snapshot) return snapshot;
  const completed = data.series?.maps
    .filter((map) => map.status === 'completed' && map.finalScore)
    .at(-1);
  return completed?.finalScore
    ? {
        mapName: completed.mapName,
        mapOrder: completed.mapOrder,
        score: completed.finalScore,
        players: { a: [], b: [] },
      }
    : null;
}
export interface ProgramSceneViewProps {
  readonly sceneId: ProgramSceneId;
  readonly data: ProgramPresentation | null;
  readonly snapshot: ProgramSnapshot | null;
  readonly scenes: ProgramSceneState | null;
  readonly resolvedPreset: HudResolvedPreset;
  readonly preview: boolean;
  readonly shortIntro: boolean;
  readonly previewBackground: boolean;
  readonly reducedMotion: boolean;
}

/** Render an already-projected scene; the host owns subscriptions and preview selection. */
export function ProgramSceneView({
  sceneId,
  data,
  snapshot,
  scenes,
  resolvedPreset,
  preview,
  shortIntro,
  previewBackground,
  reducedMotion,
}: ProgramSceneViewProps) {
  const resolveAssetUrl = useAssetUrl();
  const intro = useRef<HTMLDivElement>(null);
  const preparingIntro = !preview && scenes?.preparing?.target === 'matchup';
  const onAirIntro = scenes?.active === 'matchup';
  const incomingIntro =
    scenes && (preparingIntro || onAirIntro)
      ? {
          revision: preparingIntro
            ? scenes.preparing!.revision
            : (scenes.introRevision ?? scenes.revision),
          duration: scenes.director?.introDurationMs ?? 6000,
          elapsed: preparingIntro ? 0 : (scenes.director?.sceneElapsedMs ?? 0),
        }
      : null;
  // Retain only presentation identity, never telemetry or a second game clock.
  // A failed poll or another scene's revision cannot restart this source's opening.
  const [acceptedIntro, setAcceptedIntro] = useState(incomingIntro);
  if (
    incomingIntro &&
    (incomingIntro.revision !== acceptedIntro?.revision ||
      incomingIntro.duration !== acceptedIntro.duration ||
      incomingIntro.elapsed !== acceptedIntro.elapsed)
  )
    setAcceptedIntro(incomingIntro);
  const revision = preview ? 'preview' : (incomingIntro ?? acceptedIntro)?.revision;
  const duration = preview
    ? shortIntro
      ? 2000
      : 6000
    : ((incomingIntro ?? acceptedIntro)?.duration ?? 6000);
  const introPaused =
    !preview && (!scenes || preparingIntro || !onAirIntro || scenes.director?.mode === 'blocked');
  const hasSnapshot = snapshot != null;
  const hasPresentation = data != null;
  const targetSignature = JSON.stringify([
    resolvedPreset.layout.widgets['top-score-bar'],
    resolvedPreset.widgets['top-score-bar'],
    data?.series?.entrants,
  ]);
  const syncedAnimations = useRef(new WeakSet<Animation>());
  const synchronizeNewAnimations = useEffectEvent((animations: Animation[], root: HTMLElement) => {
    const elapsed = preview
      ? Number(root.getAnimations()[0]?.currentTime ?? 0)
      : preparingIntro
        ? 0
        : onAirIntro
          ? (scenes?.director?.sceneElapsedMs ?? 0)
          : (acceptedIntro?.elapsed ?? 0);
    for (const animation of animations) {
      animation.currentTime = elapsed;
      syncedAnimations.current.add(animation);
      if (introPaused) animation.pause();
    }
  });
  useEffect(() => {
    if (sceneId !== 'matchup' || !intro.current || !hasSnapshot || reducedMotion) return;
    const root = intro.current;
    const canvas = root.closest('.program-scene')!;
    const animations: Animation[] = [];
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const scale = canvas.getBoundingClientRect().width / 1920;
      const short = duration <= 2000;
      const hold = short ? 0.48 : 0.72;
      for (const side of ['a', 'b']) {
        const logo = root.querySelector<HTMLImageElement>(`.intro-team--${side} img`);
        const name = root.querySelector<HTMLElement>(`.intro-team--${side} strong`);
        const targetLogo = canvas.querySelector<HTMLImageElement>(
          `[data-team-logo-slot="${side}"] img`,
        );
        const targetName = canvas.querySelector<HTMLElement>(
          `[data-team-logo-slot="${side}"] .match-header__team-name`,
        );
        const source = logo?.naturalWidth ? logo : name;
        const target =
          source === logo && targetLogo?.naturalWidth
            ? targetLogo
            : source === name && targetName?.getBoundingClientRect().width
              ? targetName
              : null;
        const team = root.querySelector<HTMLElement>(`.intro-team--${side}`);
        if (team) {
          const origin = side === 'a' ? '0% 100%' : '100% 100%';
          animations.push(
            team.animate(
              [
                {
                  clipPath: `ellipse(0% 0% at ${origin})`,
                  offset: 0,
                  easing: 'cubic-bezier(.2,.7,.2,1)',
                },
                { clipPath: `ellipse(150% 180% at ${origin})`, offset: short ? 0.2 : 0.18 },
                { clipPath: 'none', offset: short ? 0.21 : 0.19 },
                { clipPath: 'none', offset: 1 },
              ],
              { duration, fill: 'both', easing: 'linear' },
            ),
          );
        }
        if (source) {
          const from = source.getBoundingClientRect();
          const to = target?.getBoundingClientRect();
          const transform =
            to && from.width && from.height
              ? `translate(${(to.x + to.width / 2 - from.x - from.width / 2) / scale}px,${(to.y + to.height / 2 - from.y - from.height / 2) / scale}px) scale(${to.width / from.width},${to.height / from.height})`
              : 'translateY(-12px)';
          animations.push(
            source.animate(
              [
                { opacity: 0, transform: 'none', offset: 0 },
                { opacity: 1, transform: 'none', offset: 0.04 },
                {
                  opacity: 1,
                  transform: 'none',
                  offset: hold,
                  easing: 'cubic-bezier(.22,.7,.2,1)',
                },
                { opacity: target ? 1 : 0, transform, offset: 0.9 },
                { opacity: 0, transform, offset: 1 },
              ],
              { duration, fill: 'both', easing: 'linear' },
            ),
          );
        }
        if (name && source !== name)
          animations.push(
            name.animate(
              [
                { opacity: 0, transform: 'none', offset: 0 },
                { opacity: 1, transform: 'none', offset: 0.04 },
                {
                  opacity: 1,
                  transform: 'none',
                  offset: hold,
                  easing: 'cubic-bezier(.22,.7,.2,1)',
                },
                { opacity: 0, transform: 'translateY(-12px)', offset: 0.86 },
                { opacity: 0, transform: 'translateY(-12px)', offset: 1 },
              ],
              { duration, fill: 'both', easing: 'linear' },
            ),
          );
      }
      // New animations join the accepted presentation position once. Polling only
      // corrects significant drift; no browser clock can extend the Director budget.
      synchronizeNewAnimations(animations, root);
    };
    const images = [
      ...canvas.querySelectorAll<HTMLImageElement>('.intro-team img, [data-team-logo-slot] img'),
    ];
    void Promise.all([
      document.fonts.ready,
      ...images.map((img) => img.decode().catch(() => undefined)),
    ]).then(measure);
    return () => {
      cancelled = true;
      animations.forEach((animation) => animation.cancel());
    };
    // Director polling is handled below, not by recreating this choreography.
  }, [sceneId, duration, revision, hasSnapshot, hasPresentation, targetSignature, reducedMotion]);
  useEffect(() => {
    if (!intro.current?.getAnimations) return;
    const hudEntrance = intro.current.parentElement?.querySelector('.intro-hud');
    const animations = [
      ...intro.current.getAnimations({ subtree: true }),
      ...(hudEntrance?.getAnimations() ?? []),
    ];
    for (const animation of animations) {
      if (preparingIntro) animation.currentTime = 0;
      if (
        !preview &&
        !preparingIntro &&
        onAirIntro &&
        scenes?.director?.sceneElapsedMs !== undefined
      ) {
        const elapsed = scenes.director.sceneElapsedMs;
        const paused = scenes.director.mode === 'blocked';
        if (
          (!syncedAnimations.current.has(animation) && elapsed > 1000) ||
          paused ||
          animation.playState === 'paused' ||
          Math.abs(Number(animation.currentTime ?? 0) - elapsed) > 1000
        ) {
          animation.currentTime = elapsed;
        }
        syncedAnimations.current.add(animation);
      }
      if (introPaused) animation.pause();
      else if (
        animation.playState === 'paused' &&
        Number(animation.currentTime ?? 0) <
          Number(animation.effect?.getComputedTiming().endTime ?? Infinity)
      )
        // play() rewinds an already completed animation. Keep its settled frame.
        animation.play();
    }
  }, [
    scenes?.director?.mode,
    scenes?.director?.sceneElapsedMs,
    preview,
    hasPresentation,
    hasSnapshot,
    revision,
    preparingIntro,
    onAirIntro,
    introPaused,
  ]);
  return (
    <ProgramCanvas className={`program-scene program-scene--${sceneId}`}>
      {preview && (sceneId === 'matchup' || sceneId === 'gameplay') && previewBackground ? (
        <div
          className="intro-preview-backdrop"
          style={{
            backgroundImage: assetCssUrl(
              resolveAssetUrl(getMapThumbnail('de_ancient')?.outputPath ?? ''),
            ),
          }}
        />
      ) : null}
      {sceneId !== 'matchup' && sceneId !== 'gameplay' ? (
        <BroadcastArc hero={sceneId === 'waiting'} />
      ) : null}
      {data && sceneId !== 'matchup' && sceneId !== 'gameplay' ? (
        <BroadcastIdentity data={data} />
      ) : null}
      {preview ? <p className="program-preview-source">示例画面</p> : null}
      {data ? (
        sceneId === 'waiting' ? (
          <Waiting data={data} />
        ) : sceneId === 'map_result' ? (
          <MapResult data={data} />
        ) : sceneId === 'gameplay' ? (
          <GameplayHud
            snapshot={snapshot}
            resolvedPreset={resolvedPreset}
            gg={
              scenes?.active === 'gameplay' &&
              (scenes.director?.gg?.remainingMs ?? 0) > 0 &&
              scenes.director?.gg?.mapEpoch === snapshot?.cursor.mapEpoch
            }
          />
        ) : sceneId === 'matchup' ? (
          <>
            <div
              key={`hud:${revision}`}
              className="intro-hud"
              style={{ animationDelay: `${Math.max(0, duration - 600)}ms` }}
            >
              <GameplayHud snapshot={snapshot} resolvedPreset={resolvedPreset} />
            </div>
            <div
              ref={intro}
              className="intro-body"
              data-intro-mode={duration <= 2000 ? 'short' : 'full'}
              key={revision}
              style={{ animationDuration: `${duration}ms` }}
            >
              <div className="intro-art">
                <BroadcastArc hero />
              </div>
              <p className="intro-map">
                MAP {data.series?.currentMapOrder ?? 1} ·{' '}
                {mapName(
                  data.series?.maps.find((map) => map.mapOrder === data.series?.currentMapOrder)
                    ?.mapName ?? '',
                )}
              </p>
              {(['a', 'b'] as const).map((side) => (
                <div className={`intro-team intro-team--${side}`} key={side}>
                  {data.series?.entrants[side].logoUrl ? (
                    <div className="intro-emblem">
                      <Media src={data.series.entrants[side].logoUrl} />
                    </div>
                  ) : null}
                  <strong>{data.series?.entrants[side].name}</strong>
                </div>
              ))}
              <span className="intro-vs">VS</span>
              {(data.series?.currentMapOrder ?? 1) > 1 ? (
                <p className="intro-series">
                  {data.series?.score.a ?? '—'} : {data.series?.score.b ?? '—'}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <SummaryBoard data={data} scene={sceneId} />
        )
      ) : sceneId === 'waiting' ? (
        <h1 className="waiting-neutral">BROADCAST STARTING SOON</h1>
      ) : sceneId === 'gameplay' ? (
        <GameplayHud snapshot={snapshot} resolvedPreset={resolvedPreset} />
      ) : null}
    </ProgramCanvas>
  );
}
