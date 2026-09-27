import type { CSSProperties } from 'react';
import type { BpSnapshot } from '@rivalhub-broadcast/protocol/bp';
import { getMapThumbnail } from '@rivalhub-broadcast/cs2-assets';
import { ProgramCanvas } from '../program/ProgramCanvas';
import './bp.css';

export function BpPresentation({
  snapshot,
  animate = false,
}: {
  readonly snapshot: BpSnapshot | null;
  readonly animate?: boolean;
}) {
  const projection = snapshot?.projection;
  const visible = snapshot !== null && snapshot.state !== 'hidden';
  return (
    <ProgramCanvas className="bp-canvas">
      {projection && visible ? (
        <section
          className="bp-scene"
          aria-label="地图禁选"
          data-state={snapshot.state}
          data-animate={animate}
          data-format={projection.format}
          data-revealed-count={snapshot.revealedCount}
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
              const steps = projection.steps.slice(0, snapshot.revealedCount);
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
              {snapshot.state === 'shown'
                ? '地图禁选完成'
                : `地图禁选 · ${snapshot.revealedCount} / ${projection.steps.length}`}
            </span>
            <div className="bp-progress" aria-hidden="true">
              {projection.steps.map((_, i) => (
                <i key={i} data-on={i < snapshot.revealedCount} />
              ))}
            </div>
            <span>{projection.format.toUpperCase()}</span>
          </div>
        </section>
      ) : null}
    </ProgramCanvas>
  );
}
