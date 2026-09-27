import { useSyncExternalStore } from 'react';
import type { ProgramSceneId } from '@rivalhub-broadcast/protocol/program-scenes';
import { programScene } from '@rivalhub-broadcast/protocol/program-scenes';
import { useLocalChannelClient } from '../realtime';
import { ProgramCanvas } from './ProgramCanvas';
import './program-scenes.css';

function score(a: number, b: number) {
  return `${a} : ${b}`;
}

export function ProgramScenePage({ sceneId }: { readonly sceneId: ProgramSceneId }) {
  const client = useLocalChannelClient('program');
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const program = connection.state === 'live' ? connection.current?.payload : undefined;
  const series = program?.series;
  const match = program?.match;
  const safe =
    sceneId === 'waiting' ||
    (program?.status.context === 'fresh' &&
      program.status.identity !== 'mismatch' &&
      series?.bindingState === 'bound');
  const current = series?.maps.find((map) => map.status === 'current');
  const completed = [...(series?.maps ?? [])].reverse().find((map) => map.status === 'completed');
  const next = series?.maps.find((map) => map.status === 'pending');
  const title = programScene(sceneId).title;
  const a = series?.entrants.a;
  const b = series?.entrants.b;
  const resultScene = sceneId === 'map_result' || sceneId === 'match_result';
  const resultSafe =
    !resultScene ||
    (sceneId === 'map_result' ? completed?.finalScore != null : series?.status === 'completed');

  return (
    <ProgramCanvas className={`program-scene program-scene--${sceneId}`}>
      {safe && resultSafe ? (
        <main className="program-scene__content" aria-label={title}>
          <p className="program-scene__brand">RIVALHUB BROADCAST</p>
          <p className="program-scene__eyebrow">
            {match?.competition.name ?? 'RivalHub Broadcast'}
            {match?.stage ? ` · ${match.stage}` : ''}
            {series ? ` · ${series.format.toUpperCase()}` : ''}
          </p>
          <h1>{title}</h1>
          {a && b ? (
            <section className="program-scene__teams">
              <div>
                {a.logoUrl ? <img src={a.logoUrl} alt="" /> : null}
                <strong>{a.name}</strong>
              </div>
              <span>
                {sceneId === 'waiting' || sceneId === 'matchup'
                  ? 'VS'
                  : score(series.score.a, series.score.b)}
              </span>
              <div>
                {b.logoUrl ? <img src={b.logoUrl} alt="" /> : null}
                <strong>{b.name}</strong>
              </div>
            </section>
          ) : sceneId === 'waiting' ? (
            <p className="program-scene__waiting">节目即将开始</p>
          ) : null}
          {sceneId === 'halftime' && current ? (
            <p className="program-scene__detail">{current.mapName}</p>
          ) : null}
          {sceneId === 'map_result' && completed?.finalScore ? (
            <p className="program-scene__detail">
              {completed.mapName} · {score(completed.finalScore.a, completed.finalScore.b)}
            </p>
          ) : null}
          {sceneId === 'intermap' ? (
            <div className="program-scene__detail">
              {completed?.finalScore ? (
                <p>
                  上一图 {completed.mapName} ·{' '}
                  {score(completed.finalScore.a, completed.finalScore.b)}
                </p>
              ) : null}
              {next ? <p>下一图 {next.mapName}</p> : null}
            </div>
          ) : null}
          {sceneId === 'match_result' ? (
            <div className="program-scene__maps">
              {series?.maps
                .filter((map) => map.status === 'completed' && map.finalScore)
                .map((map) => (
                  <p key={map.mapOrder}>
                    {map.mapName} · {score(map.finalScore!.a, map.finalScore!.b)}
                  </p>
                ))}
            </div>
          ) : null}
        </main>
      ) : null}
    </ProgramCanvas>
  );
}
