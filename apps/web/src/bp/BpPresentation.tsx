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
