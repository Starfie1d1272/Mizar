import type { BpSnapshot } from '@mizar/protocol/bp';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { useState } from 'react';
import { ProgramCanvas } from '../program/ProgramCanvas';
import './bp.css';
import '../program/broadcast-material.css';
import { BroadcastArc } from '../program/BroadcastArc';

function TeamLogo({
  src,
  name,
  entrant,
}: {
  readonly src: string | null;
  readonly name: string;
  readonly entrant: 'a' | 'b';
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const available = Boolean(src) && failedSrc !== src;
  return (
    <span
      className="bp-team-logo"
      role="img"
      aria-label={`${name} 队标${available ? '' : '不可用'}`}
    >
      {!available ? (
        <span className="bp-logo-fallback" aria-hidden="true">
          {entrant.toUpperCase()}
        </span>
      ) : null}
      {available && src ? (
        <img
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
          onLoad={(event) => {
            // Inspect readable assets for an empty transparent image.
            // Remote assets without CORS remain usable.
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 32;
            const context = canvas.getContext('2d');
            if (!context) return;
            try {
              context.drawImage(event.currentTarget, 0, 0, 32, 32);
              const pixels = context.getImageData(0, 0, 32, 32).data;
              if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) setFailedSrc(src);
            } catch {
              // Cross-origin pixels cannot be inspected in the browser.
            }
          }}
        />
      ) : null}
    </span>
  );
}

function CompactMapArt({ mapName }: { readonly mapName: string }) {
  const image = getMapThumbnail(mapName);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = image?.outputPath;
  return (
    <div className="bp-compact-art">
      {src && src !== failedSrc ? (
        <img src={src} alt="" onError={() => setFailedSrc(src)} />
      ) : (
        <span className="bp-compact-missing">地图图片不可用</span>
      )}
      <strong>{mapName.replace(/^de_/, '').toUpperCase()}</strong>
    </div>
  );
}

/** Compact presentation consumes the same reveal cursor as the full-screen scene. */
export function BpCompactPresentation({
  snapshot,
  animate = false,
}: {
  readonly snapshot: BpSnapshot | null;
  readonly animate?: boolean;
}) {
  const projection = snapshot?.projection;
  const steps = projection?.steps.slice(0, snapshot?.revealedCount ?? 0) ?? [];
  const currentCard = snapshot?.state === 'revealing' ? steps.at(-1)?.cardIndex : undefined;
  return (
    <ProgramCanvas className="bp-canvas">
      {projection && snapshot?.state !== 'hidden' ? (
        <section
          className="bp-compact"
          aria-label="地图禁选"
          data-state={snapshot?.state}
          data-animate={animate}
        >
          <div className="bp-compact-status">
            <span
              className="bp-compact-match"
              title={`${projection.entrants.a.name} vs ${projection.entrants.b.name}`}
            >
              {projection.entrants.a.name} <b>VS</b> {projection.entrants.b.name}
            </span>
            <span>
              {projection.format.toUpperCase()} ·{' '}
              {snapshot?.state === 'shown' ? '地图禁选完成' : '地图禁选'}
            </span>
          </div>
          <div className="bp-compact-cards">
            {projection.cards.map((card, index) => {
              const cardStep = steps.findIndex(
                (step) => step.cardIndex === index && step.kind === 'card',
              );
              const shown = cardStep !== -1;
              const sideShown = steps.some(
                (step) => step.cardIndex === index && step.kind === 'side-choice',
              );
              const team = shown && card.entrant ? projection.entrants[card.entrant] : null;
              return (
                <article
                  className="bp-compact-card"
                  data-kind={shown ? card.kind : 'pending'}
                  data-current={shown && index === currentCard}
                  key={index}
                >
                  {shown ? (
                    <>
                      <CompactMapArt mapName={card.mapName} />
                      <div className="bp-compact-action">
                        <span>
                          {card.kind === 'ban' ? '× ' : ''}
                          {card.kind.toUpperCase()} · {String(cardStep + 1).padStart(2, '0')}
                        </span>
                        {index === currentCard ? <span>当前</span> : null}
                      </div>
                      <div className="bp-compact-owner">
                        {team && card.entrant ? (
                          <>
                            <TeamLogo src={team.logoUrl} name={team.name} entrant={card.entrant} />
                            <span title={team.name}>{team.name}</span>
                          </>
                        ) : (
                          <span>决胜地图</span>
                        )}
                        {sideShown && card.sideChoice ? (
                          <small>
                            <span title={projection.entrants[card.sideChoice.entrant].name}>
                              {projection.entrants[card.sideChoice.entrant].name}
                            </span>
                            <b> · {card.sideChoice.side} 开局</b>
                          </small>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <span className="bp-compact-pending">待揭示</span>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </ProgramCanvas>
  );
}

export function BpPresentation({
  snapshot,
  animate = false,
}: {
  readonly snapshot: BpSnapshot | null;
  readonly animate?: boolean;
}) {
  const projection = snapshot?.projection;
  const visible = snapshot !== null && snapshot.state !== 'hidden';
  const effectiveRevealedCount = snapshot?.revealedCount ?? 0;
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
          <BroadcastArc />
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
                  <TeamLogo src={team.logoUrl} name={team.name} entrant={key} />
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
                >
                  {image ? <img className="bp-map-art" src={image.outputPath} alt="" /> : null}
                  <div className="bp-shade" />
                  <span className="bp-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="bp-badge">{card.kind.toUpperCase()}</span>
                  <div className="bp-copy">
                    <h2>{card.mapName.replace(/^de_/, '').toUpperCase()}</h2>
                    <div className="bp-owner">
                      {team && card.entrant && card.kind !== 'decider' ? (
                        <>
                          <TeamLogo src={team.logoUrl} name={team.name} entrant={card.entrant} />
                          <div className="bp-owner-copy">
                            <span title={team.name}>{team.name}</span>
                          </div>
                        </>
                      ) : (
                        '决胜地图'
                      )}
                    </div>
                    {card.sideChoice ? (
                      <div
                        className="bp-side-choice"
                        data-visible={sideShown}
                        data-entrant={card.sideChoice.entrant}
                        data-side={card.sideChoice.side}
                        aria-hidden={!sideShown}
                      >
                        <span title={projection.entrants[card.sideChoice.entrant].name}>
                          {projection.entrants[card.sideChoice.entrant].name}
                        </span>
                        <strong>{card.sideChoice.side} 开局</strong>
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
