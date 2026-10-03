import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { useHudConfigClient } from '../realtime/hud-config-client';
import {
  programPresentationSchema,
  type ProgramPresentation,
  type ProgramSceneId,
} from '@mizar/protocol/program-scenes';
import { useLocalChannelClient } from '../realtime';
import { useProgramScenes } from '../workspace/client';
import { presentationPreview, programPreviewSnapshot } from './presentation-preview';
import { ProgramCanvas } from './ProgramCanvas';
import { GameplayHud } from './GameplayHud';
import './program-scenes.css';

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
  return (
    <footer className="broadcast-identity">
      <div>
        <Media src={data.eventLogoUrl} />
        <strong>{data.match?.competition.name}</strong>
        <span>{data.match?.stage}</span>
      </div>
      <div className="broadcast-signature">
        <img src="/brand/mizar-mark-mono.svg" alt="" />
        <span>MIZAR</span>
      </div>
    </footer>
  );
}
function usePresentation(preview: boolean) {
  const [value, setValue] = useState<ProgramPresentation | null>(null);
  useEffect(() => {
    if (preview) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/local/v1/program-presentation', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const next = programPresentationSchema.parse(await response.json());
          if (active) setValue(next);
        }
      } catch {
        /* Static on-air continuity: retain the last safe server projection. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 250);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [preview]);
  return value;
}

function MapStrip({ data }: { data: ProgramPresentation }) {
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
                {asset ? <img src={asset.outputPath} alt="" /> : null}
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
  const summary = scene === 'halftime' ? data.halftime : data.completed.at(-1);
  return (
    <>
      <MapStrip data={data} />
      <div className="summary-caption">
        <span>
          {scene === 'halftime'
            ? 'HALFTIME'
            : scene === 'match_result'
              ? 'MATCH COMPLETE'
              : 'BETWEEN MAPS'}
        </span>
        <strong>
          {summary
            ? `${mapName(summary.mapName)} · ${number(summary.score.a)} : ${number(summary.score.b)}`
            : 'STATS UNAVAILABLE'}
        </strong>
        <span>{scene === 'match_result' ? 'FINAL MAP STATS' : 'MAP STATS'}</span>
      </div>
      <div className="summary-stat-axis" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i}>K/D</span>
        ))}
      </div>
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
            {summary && summary.players[side].length === 0 ? (
              <p className="summary-unavailable">STATS UNAVAILABLE</p>
            ) : null}
          </div>
        ))}
      </div>
      {data.series ? (
        <footer className="summary-footer">
          <strong>{data.series.entrants.a.name}</strong>
          <span>
            {data.series.score.a} : {data.series.score.b}
          </span>
          <strong>{data.series.entrants.b.name}</strong>
        </footer>
      ) : null}
    </>
  );
}
function Waiting({ data }: { data: ProgramPresentation }) {
  const series = data.series;
  return (
    <main className="waiting-layout">
      {series?.maps[0] && getMapThumbnail(series.maps[0].mapName) ? (
        <img
          className="waiting-backdrop"
          src={getMapThumbnail(series.maps[0].mapName)!.outputPath}
          alt=""
        />
      ) : null}
      <header className="waiting-event">
        <Media src={data.eventLogoUrl} />
        <span>{data.match?.competition.name ?? ''}</span>
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
                <div className="waiting-emblem">
                  <Media
                    src={series.entrants[side].logoUrl}
                    fallback={teamInitials(series.entrants[side].name)}
                  />
                </div>
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
        {(['previous', 'next'] as const).map((kind) => {
          const card = data[kind];
          return card ? (
            <article className={`waiting-schedule--${kind}`} key={kind}>
              <small>{kind === 'next' ? 'UP NEXT' : 'PREVIOUS MATCH'}</small>
              <strong>
                {card.a} <span>{card.score ?? 'VS'}</span> {card.b}
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
  const summary = data.completed.at(-1);
  const series = data.series;
  return summary && series ? (
    <main className="result-sting">
      {getMapThumbnail(summary.mapName) ? (
        <img
          className="result-backdrop"
          src={getMapThumbnail(summary.mapName)!.outputPath}
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
          <span className="result-series-score">{series.score[side]}</span>
          <strong className="result-team-name">{series.entrants[side].name}</strong>
        </div>
      ))}
    </main>
  ) : null;
}
export function ProgramScenePage({ sceneId }: { readonly sceneId: ProgramSceneId }) {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const preview = params.get('preview') === '1';
  const liveData = usePresentation(preview);
  const data = preview ? presentationPreview(sceneId, params.get('variant')) : liveData;
  const scenes = useProgramScenes();
  const hud = useHudConfigClient();
  const intro = useRef<HTMLDivElement>(null);
  const client = useLocalChannelClient('program');
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const snapshot = preview
    ? programPreviewSnapshot('gameplay', params.get('variant'))
    : connection.current;
  const duration = preview
    ? params.get('intro') === 'short'
      ? 2000
      : 6000
    : (scenes?.director?.introDurationMs ?? 6000);
  const preparingIntro = !preview && scenes?.preparing?.target === 'matchup';
  const revision = preview
    ? 'preview'
    : preparingIntro
      ? scenes.preparing!.revision
      : scenes?.revision;
  const hasSnapshot = snapshot != null;
  const hasPresentation = data != null;
  const syncedAnimations = useRef(new WeakSet<Animation>());
  useEffect(() => {
    if (
      sceneId !== 'matchup' ||
      !intro.current ||
      !hasSnapshot ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const root = intro.current;
    const canvas = root.closest('.program-scene')!;
    const scale = canvas.getBoundingClientRect().width / 1920;
    const animations: Animation[] = [];
    for (const side of ['a', 'b']) {
      const logo = root.querySelector<HTMLElement>(`.intro-team--${side} img`);
      const destination = canvas.querySelector<HTMLElement>(`[data-team-logo-slot="${side}"] img`);
      if (!logo || !destination || !logo.animate) continue;
      const from = logo.getBoundingClientRect();
      const to = destination.getBoundingClientRect();
      const dx = (to.x + to.width / 2 - from.x - from.width / 2) / scale;
      const dy = (to.y + to.height / 2 - from.y - from.height / 2) / scale;
      animations.push(
        logo.animate(
          [
            { transform: 'translate(0,0) scale(1)' },
            { transform: `translate(${dx}px,${dy}px) scale(${to.width / from.width})` },
          ],
          {
            duration: 600,
            delay: Math.max(0, duration - 1200),
            fill: 'forwards',
            easing: 'cubic-bezier(.22,.7,.2,1)',
          },
        ),
      );
      const name = root.querySelector<HTMLElement>(`.intro-team--${side} strong`);
      if (name)
        animations.push(
          name.animate(
            [
              { opacity: 1, transform: 'translateY(0)' },
              { opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.4)` },
            ],
            {
              duration: 600,
              delay: Math.max(0, duration - 1200),
              fill: 'forwards',
              easing: 'ease-in-out',
            },
          ),
        );
    }
    return () => animations.forEach((animation) => animation.cancel());
  }, [sceneId, duration, revision, hasSnapshot, hasPresentation]);
  useEffect(() => {
    if (!intro.current?.getAnimations) return;
    const hudEntrance = intro.current.parentElement?.querySelector('.intro-hud');
    const animations = [
      ...intro.current.getAnimations({ subtree: true }),
      ...(hudEntrance?.getAnimations() ?? []),
    ];
    for (const animation of animations) {
      if (!preview && !preparingIntro && scenes?.director?.sceneElapsedMs !== undefined) {
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
      if (!preview && !preparingIntro && scenes?.director?.mode === 'blocked') animation.pause();
      else if (animation.playState === 'paused') animation.play();
    }
  }, [
    scenes?.director?.mode,
    scenes?.director?.sceneElapsedMs,
    preview,
    hasPresentation,
    hasSnapshot,
    revision,
    preparingIntro,
  ]);
  return (
    <ProgramCanvas className={`program-scene program-scene--${sceneId}`}>
      {preview &&
      (sceneId === 'matchup' || sceneId === 'gameplay') &&
      params.get('background') !== 'transparent' ? (
        <div
          className="intro-preview-backdrop"
          style={{ backgroundImage: `url(${getMapThumbnail('de_ancient')?.outputPath})` }}
        />
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
          <GameplayHud snapshot={snapshot ?? null} resolvedPreset={hud.current} />
        ) : sceneId === 'matchup' ? (
          <>
            <div
              key={`hud:${revision}`}
              className="intro-hud"
              style={{ animationDelay: `${Math.max(0, duration - 600)}ms` }}
            >
              <GameplayHud snapshot={snapshot ?? null} resolvedPreset={hud.current} />
            </div>
            <div
              ref={intro}
              className="intro-body"
              key={revision}
              style={{ animationDuration: `${duration}ms` }}
            >
              <div
                className="intro-orbit"
                style={{ animationDelay: `${Math.max(0, duration - 1200)}ms` }}
              />
              <div
                className="intro-star"
                style={{ animationDelay: `${Math.max(0, duration - 600)}ms` }}
              />
              <p className="intro-map">
                MAP {data.series?.currentMapOrder ?? 1} ·{' '}
                {mapName(
                  data.series?.maps.find((map) => map.mapOrder === data.series?.currentMapOrder)
                    ?.mapName ?? '',
                )}
              </p>
              {(['a', 'b'] as const).map((side) => (
                <div className={`intro-team intro-team--${side}`} key={side}>
                  <div className="intro-emblem">
                    <Media
                      src={data.series?.entrants[side].logoUrl}
                      fallback={data.series?.entrants[side].name.slice(0, 2) ?? ''}
                    />
                  </div>
                  <strong>{data.series?.entrants[side].name}</strong>
                </div>
              ))}
              <span className="intro-vs">VS</span>
              {(data.series?.currentMapOrder ?? 1) > 1 ? (
                <p className="intro-series">
                  {data.series?.score.a} : {data.series?.score.b}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <SummaryBoard data={data} scene={sceneId} />
        )
      ) : sceneId === 'waiting' ? (
        <h1 className="waiting-neutral">BROADCAST STARTING SOON</h1>
      ) : null}
    </ProgramCanvas>
  );
}
