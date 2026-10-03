import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { Panel, StatusPill } from '../ui';
import { getMapThumbnail } from '@mizar/cs2-assets';
import { mapLabel, matchMaps, matchRound, sideChoice } from './match-presentation';

export type MatchSection = 'details' | 'roster' | 'maps';
const dateLabel = (value: string | null) =>
  value
    ? `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))}（北京时间）`
    : '待安排';

/** All current-match facts come from the same provider-neutral document. */
export function MatchDocumentView({
  document: match,
  section,
}: {
  document: MatchDocumentV1;
  section: MatchSection;
}) {
  if (section === 'details')
    return (
      <Panel className="match-document-summary">
        <div className="preparation-match__meta">
          <strong>{match.competition.name}</strong>
          <StatusPill tone="info">
            {
              {
                scheduled: '待进行',
                in_progress: '进行中',
                finished: '已结束',
                cancelled: '已取消',
              }[match.status]
            }
          </StatusPill>
        </div>
        <h2>
          {match.entrants.a.name} <span>vs</span> {match.entrants.b.name}
        </h2>
        <p>
          {[match.stageLabel, matchRound(match), match.format.toUpperCase()]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <dl className="preparation-facts">
          <div>
            <dt>计划开始</dt>
            <dd>{dateLabel(match.scheduledAt)}</dd>
          </div>
          {match.scoreA !== null && match.scoreB !== null ? (
            <div>
              <dt>系列比分</dt>
              <dd>
                {match.scoreA} : {match.scoreB}
              </dd>
            </div>
          ) : null}
          {match.commentators.length ? (
            <div>
              <dt>解说</dt>
              <dd>{match.commentators.map((person) => person.displayName).join(' · ')}</dd>
            </div>
          ) : null}
        </dl>
        {match.matchLabel || match.stakesLabel ? (
          <details>
            <summary>补充资料</summary>
            {match.matchLabel ? <p>{match.matchLabel}</p> : null}
            {match.stakesLabel ? <p>{match.stakesLabel}</p> : null}
          </details>
        ) : null}
      </Panel>
    );
  if (section === 'roster')
    return (
      <div className="preparation-columns">
        {(['a', 'b'] as const).map((side) => {
          const team = match.entrants[side];
          return (
            <Panel key={side}>
              <header className="preparation-team-heading">
                {team.logoUrl ? (
                  <img className="preparation-logo" src={team.logoUrl} alt={`${team.name} 队标`} />
                ) : null}
                <h2>{team.name}</h2>
              </header>
              {team.players.length === 0 ? (
                <p>尚未提供名单。</p>
              ) : (
                [true, false].map((starter) => (
                  <section key={String(starter)}>
                    <h3>{starter ? '首发' : '替补'}</h3>
                    <ul className="preparation-roster">
                      {team.players
                        .filter((player) => player.isStarter === starter)
                        .map((player) => (
                          <li key={player.playerId}>
                            {player.avatarUrl ? (
                              <img src={player.avatarUrl} alt="" width="32" height="32" />
                            ) : null}
                            <span>{player.displayName ?? '未命名选手'}</span>
                          </li>
                        ))}
                    </ul>
                    {!team.players.some((player) => player.isStarter === starter) ? (
                      <p>{starter ? '尚未提供首发。' : '暂无替补。'}</p>
                    ) : null}
                  </section>
                ))
              )}
              {team.players.length ? (
                <details>
                  <summary>Steam 身份</summary>
                  <dl className="preparation-facts">
                    {team.players.map((player) => (
                      <div key={player.playerId}>
                        <dt>{player.displayName ?? '未命名选手'}</dt>
                        <dd>{player.steam64 ?? '未提供'}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </Panel>
          );
        })}
      </div>
    );
  const maps = matchMaps(match);
  return (
    <div className="match-map-workspace">
      <Panel>
        <div className="preparation-match__meta">
          <h2>比赛地图</h2>
          <StatusPill tone="info">{match.format.toUpperCase()}</StatusPill>
        </div>
        <p>
          {match.entrants.a.name} vs {match.entrants.b.name}
        </p>
        {maps.length ? (
          <div className="match-map-grid">
            {maps.map((map) => {
              const image = getMapThumbnail(map.name);
              return (
                <article
                  className="match-map-card"
                  key={map.name}
                  aria-label={`图 ${map.order} · ${mapLabel(map.name)}`}
                >
                  {image ? <img className="match-map-image" src={image.outputPath} alt="" /> : null}
                  <div className="match-map-body">
                    <small>
                      图 {map.order} · {map.selection}
                    </small>
                    <h3>{mapLabel(map.name)}</h3>
                    {map.score ? <strong className="match-map-score">{map.score}</strong> : null}
                    {map.conflict ? (
                      <StatusPill tone="warning">开局阵营待核对</StatusPill>
                    ) : map.startA ? (
                      <dl className="match-map-sides" aria-label="开局阵营">
                        <div>
                          <dt>{match.entrants.a.name}</dt>
                          <dd>{map.startA} 开局</dd>
                        </div>
                        <div>
                          <dt>{match.entrants.b.name}</dt>
                          <dd>{map.startB} 开局</dd>
                        </div>
                      </dl>
                    ) : (
                      <p>开局阵营待定</p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p>等待地图确定</p>
        )}
      </Panel>
      <Panel>
        <h2>禁选过程</h2>
        {match.veto.length ? (
          <ol className="match-veto-list" aria-label="BP 步骤">
            {[...match.veto]
              .sort((a, b) => a.stepOrder - b.stepOrder)
              .map((step) => {
                const team = Object.values(match.entrants).find((t) => t.entryId === step.entryId);
                const choice = sideChoice(match, step);
                const image = getMapThumbnail(step.mapName);
                return (
                  <li key={step.stepOrder}>
                    <span className="match-veto-number">{step.stepOrder}</span>
                    {image ? <img src={image.outputPath} alt="" /> : <span />}
                    <StatusPill tone="info">
                      {
                        { ban: '禁用', pick: '选图', side_pick: '选边', decider: '决胜图' }[
                          step.actionType
                        ]
                      }
                    </StatusPill>
                    <div className="match-veto-description">
                      <strong>{mapLabel(step.mapName)}</strong>
                      <span>
                        {step.actionType === 'decider' ? '剩余地图' : (team?.name ?? '队伍待确认')}
                      </span>
                    </div>
                    {choice ? (
                      <span className="match-veto-side">
                        {choice.name} 选 {choice.side} 开局
                      </span>
                    ) : null}
                  </li>
                );
              })}
          </ol>
        ) : (
          <p>等待禁选记录</p>
        )}
        {match.mapPool.length ? (
          <details className="match-map-pool">
            <summary>赛事地图池 · {match.mapPool.length} 张</summary>
            <p>{match.mapPool.map(mapLabel).join(' · ')}</p>
          </details>
        ) : null}
      </Panel>
    </div>
  );
}
