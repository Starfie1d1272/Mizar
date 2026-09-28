import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { Panel } from '../ui';

export type MatchSection = 'details' | 'roster' | 'maps';
const dateLabel = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '未安排';

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
      <Panel>
        <h2>比赛资料</h2>
        {match.competition.logoUrl ? (
          <img
            className="preparation-logo"
            src={match.competition.logoUrl}
            alt={`${match.competition.name} 赛事标志`}
          />
        ) : null}
        <dl className="preparation-facts">
          {[
            ['赛事', match.competition.name],
            ['阶段', match.stageLabel],
            ['轮次', match.roundLabel ?? '未填写'],
            ['比赛说明', match.matchLabel ?? '未填写'],
            ['赛果意义', match.stakesLabel ?? '未填写'],
            ['赛制', match.format.toUpperCase()],
            ['计划开始', dateLabel(match.scheduledAt)],
            [
              '状态',
              {
                scheduled: '待进行',
                in_progress: '进行中',
                finished: '已结束',
                cancelled: '已取消',
              }[match.status],
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {match.commentators.length ? (
          <p>解说：{match.commentators.map((person) => person.displayName).join(' · ')}</p>
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
  return (
    <Panel>
      <h2>地图与 BP</h2>
      <p>地图池：{match.mapPool.length ? match.mapPool.join(' · ') : '未提供'}</p>
      {match.maps.length ? (
        <ol>
          {match.maps.map((map) => (
            <li key={map.mapId}>
              {map.mapName}
              {map.scoreA !== null && map.scoreB !== null ? ` · ${map.scoreA} : ${map.scoreB}` : ''}
              {map.teamAStartSide
                ? ` · ${match.entrants.a.name} ${map.teamAStartSide.toUpperCase()} 开局`
                : ''}
            </li>
          ))}
        </ol>
      ) : (
        <p>尚未提供比赛地图。</p>
      )}
      {match.veto.length ? (
        <ol aria-label="BP 步骤">
          {match.veto.map((step) => (
            <li key={step.stepOrder}>
              {step.entryId === match.entrants.a.entryId
                ? match.entrants.a.name
                : step.entryId === match.entrants.b.entryId
                  ? match.entrants.b.name
                  : ''}{' '}
              {{ ban: '禁用', pick: '选择', side_pick: '选边', decider: '决胜图' }[step.actionType]}{' '}
              · {step.mapName}
              {step.side ? ` · ${step.side.toUpperCase()}` : ''}
            </li>
          ))}
        </ol>
      ) : (
        <p>尚未提供 BP。</p>
      )}
    </Panel>
  );
}
