import type { CSSProperties } from 'react';
import type { BpSnapshot } from '@mizar/protocol/bp';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { ProgramCanvas } from '../program/ProgramCanvas';
import './bp.css';

export const DEFAULT_PREVIEW_BP_PROJECTION: NonNullable<BpSnapshot['projection']> = {
  competition: 'Mizar',
  stage: '常规赛',
  format: 'bo3',
  entrants: {
    a: { name: 'FURIA', logoUrl: '/fixtures/ancient-round-03/assets/team-furia.svg' },
    b: { name: 'G2.Esports', logoUrl: '/fixtures/ancient-round-03/assets/team-g2.png' },
  },
  cards: [
    { mapName: 'de_dust2', kind: 'ban', entrant: 'a', sideChoice: null },
    { mapName: 'de_inferno', kind: 'ban', entrant: 'b', sideChoice: null },
    { mapName: 'de_ancient', kind: 'pick', entrant: 'a', sideChoice: { entrant: 'b', side: 'CT' } },
    { mapName: 'de_mirage', kind: 'pick', entrant: 'b', sideChoice: { entrant: 'a', side: 'T' } },
    { mapName: 'de_anubis', kind: 'ban', entrant: 'a', sideChoice: null },
    { mapName: 'de_vertigo', kind: 'ban', entrant: 'b', sideChoice: null },
    {
      mapName: 'de_nuke',
      kind: 'decider',
      entrant: null,
      sideChoice: { entrant: 'b', side: 'CT' },
    },
  ],
  steps: [
    { cardIndex: 0, kind: 'card' },
    { cardIndex: 1, kind: 'card' },
    { cardIndex: 2, kind: 'card' },
    { cardIndex: 2, kind: 'side-choice' },
    { cardIndex: 3, kind: 'card' },
    { cardIndex: 3, kind: 'side-choice' },
    { cardIndex: 4, kind: 'card' },
    { cardIndex: 5, kind: 'card' },
    { cardIndex: 6, kind: 'card' },
    { cardIndex: 6, kind: 'side-choice' },
  ],
};

export function BpPresentation({
  snapshot,
  animate = false,
}: {
  readonly snapshot: BpSnapshot | null;
  readonly animate?: boolean;
}) {
  const isPreview =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview') === '1';
  const projection = snapshot?.projection ?? (isPreview ? DEFAULT_PREVIEW_BP_PROJECTION : null);
  const visible =
    (snapshot !== null && snapshot.state !== 'hidden') || (isPreview && projection != null);
  const effectiveRevealedCount =
    isPreview && (snapshot === null || snapshot?.state === 'hidden') && projection
      ? projection.steps.length
      : (snapshot?.revealedCount ?? 0);
  return (
    <ProgramCanvas className="bp-canvas">
      {projection && visible ? (
        <section
          className="bp-scene"
          aria-label="地图禁选"
          data-state={snapshot?.state ?? 'shown'}
          data-animate={animate}
          data-format={projection.format}
          data-revealed-count={effectiveRevealedCount}
        >
          <div className="bp-kicker">
            <strong>{projection.competition}</strong>
            <span>
              {projection.stage} · {projection.format.toUpperCase()}
            </span>
          </div>
          <div className="bp-title">
            <h1>MAP VETO</h1>
            <span>地图禁选</span>
          </div>
          <div className="bp-teams">
            {(['a', 'b'] as const).map((key) => {
              const team = projection.entrants[key];
              return (
                <div className="bp-team" data-entrant={key} key={key}>
                  {team.logoUrl ? (
                    <img
                      src={team.logoUrl}
                      alt={`${team.name} 队标`}
                      onError={(event) => {
                        event.currentTarget.style.visibility = 'hidden';
                      }}
                    />
                  ) : null}
                  <strong>{team.name}</strong>
                </div>
              );
            })}
            <span className="bp-vs">VS</span>
          </div>
          <div className="bp-cards">
            {projection.cards.map((card, index) => {
              const steps = projection.steps.slice(0, effectiveRevealedCount);
              const shown = steps.some((s) => s.cardIndex === index && s.kind === 'card');
              const sideShown = steps.some(
                (s) => s.cardIndex === index && s.kind === 'side-choice',
              );
              const image = getMapThumbnail(card.mapName);
              const team = card.entrant === null ? null : projection.entrants[card.entrant];
              return (
                <article
                  className="bp-card"
                  key={card.mapName}
                  data-kind={card.kind}
                  data-visible={shown}
                  aria-hidden={!shown}
                  data-entrant={card.entrant ?? 'none'}
                  style={
                    {
                      '--bp-accent':
                        card.entrant === 'a'
                          ? 'var(--bp-a)'
                          : card.entrant === 'b'
                            ? 'var(--bp-b)'
                            : '#d5d9db',
                    } as CSSProperties
                  }
                >
                  {image ? <img className="bp-map-art" src={image.outputPath} alt="" /> : null}
                  <div className="bp-shade" />
                  <span className="bp-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="bp-badge">{card.kind.toUpperCase()}</span>
                  <div className="bp-copy">
                    <h2>{card.mapName.replace(/^de_/, '').toUpperCase()}</h2>
                    <div className="bp-owner">
                      {card.kind === 'decider'
                        ? '决胜地图'
                        : `${team?.name ?? ''} · ${card.kind === 'ban' ? '禁用' : '选择'}`}
                    </div>
                    {card.sideChoice ? (
                      <div
                        className="bp-side-choice"
                        data-visible={sideShown}
                        data-entrant={card.sideChoice.entrant}
                        aria-hidden={!sideShown}
                      >
                        <span>{projection.entrants[card.sideChoice.entrant].name}</span>
                        <strong>{card.sideChoice.side} 开</strong>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="bp-footer">
            <span>
              {(snapshot?.state ?? 'shown') === 'shown'
                ? '地图禁选完成'
                : `地图禁选 · ${effectiveRevealedCount} / ${projection.steps.length}`}
            </span>
            <div className="bp-progress" aria-hidden="true">
              {projection.steps.map((_, i) => (
                <i key={i} data-on={i < effectiveRevealedCount} />
              ))}
            </div>
            <span>{projection.format.toUpperCase()}</span>
          </div>
        </section>
      ) : null}
    </ProgramCanvas>
  );
}
