import { useState } from 'react';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { Button, StatusBanner, StatusPill } from '../ui';

export type WebsiteSchedule = {
  competition: { name: string };
  matches: {
    matchId: string;
    scheduledAt: string | null;
    entrantA: { name: string };
    entrantB: { name: string };
    format: string;
    stageLabel?: string | null;
  }[];
  library?: {
    entries: Record<string, { document: MatchDocumentV1; checkedAt: string; updatedAt: string }>;
    syncedAt: string | null;
    refreshing: boolean;
    error: string | null;
  };
};
const time = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚未同步';
export function RivalHubMatchLibrary({
  schedule,
  selecting,
  onSelect,
}: {
  schedule: WebsiteSchedule;
  selecting: boolean;
  onSelect: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const match = schedule.matches.find((row) => row.matchId === selected) ?? schedule.matches[0];
  const entry = match ? schedule.library?.entries[match.matchId] : null;
  const document = entry?.document;
  return (
    <div className="website-library">
      <div className="website-library-status">
        <span>过去两周 · 未来两周 · {schedule.matches.length} 场</span>
        <span>
          上次同步 {time(schedule.library?.syncedAt)}
          {schedule.library?.refreshing ? ' · 更新中' : ''}
        </span>
      </div>
      {schedule.library?.error ? (
        <StatusBanner tone="warning">
          {schedule.library.error} 浏览不受影响，载入前会重新核对网站资料。
        </StatusBanner>
      ) : null}
      <div className="website-library-columns">
        <aside aria-label="网站赛程">
          <h3>赛事赛程</h3>
          {schedule.matches.length ? (
            schedule.matches.map((row) => (
              <Button
                key={row.matchId}
                aria-pressed={match?.matchId === row.matchId}
                onClick={() => setSelected(row.matchId)}
              >
                <small>
                  {row.scheduledAt ? time(row.scheduledAt) : '待排期'} · {row.format.toUpperCase()}
                </small>
                <strong>
                  {row.entrantA.name} vs {row.entrantB.name}
                </strong>
                <small>{row.stageLabel ?? '阶段待定'}</small>
              </Button>
            ))
          ) : (
            <p>这个时间范围内暂无比赛。网站新增赛程后会自动出现在这里。</p>
          )}
        </aside>
        <section aria-label="网站比赛资料">
          {match ? (
            <>
              <div className="operator-rivalhub-header">
                <div>
                  <small>
                    {schedule.competition.name} · {match.format.toUpperCase()}
                  </small>
                  <h2>
                    {match.entrantA.name} vs {match.entrantB.name}
                  </h2>
                </div>
                <StatusPill tone="info">网站资料</StatusPill>
              </div>
              <p>
                {match.scheduledAt ? time(match.scheduledAt) : '时间待定'} ·{' '}
                {match.stageLabel ?? '阶段待定'}
                {entry ? ` · 最近核对 ${time(entry.checkedAt)}` : ''}
              </p>
              {document ? (
                <>
                  <div className="website-library-rosters">
                    {(['a', 'b'] as const).map((side) => (
                      <section key={side}>
                        <h3>{document.entrants[side].name}</h3>
                        <small>
                          首发 {document.entrants[side].players.filter((p) => p.isStarter).length}{' '}
                          人 · 替补{' '}
                          {document.entrants[side].players.filter((p) => !p.isStarter).length} 人
                        </small>
                        <ul>
                          {document.entrants[side].players.map((player) => (
                            <li key={player.playerId}>
                              <span>{player.displayName ?? '未填写名称'}</span>
                              <small>{player.isStarter ? '首发' : '替补'}</small>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                  <section>
                    <h3>地图与禁选</h3>
                    <p>
                      {document.maps.length
                        ? document.maps.map((map) => map.mapName).join(' → ')
                        : '地图尚未确定'}{' '}
                      · 已完成 {document.veto.length} 步禁选
                    </p>
                  </section>
                </>
              ) : (
                <StatusBanner tone="info">
                  {schedule.library?.error
                    ? '完整资料暂未缓存，可稍后重试。'
                    : '正在缓存本场名单与地图资料…'}
                </StatusBanner>
              )}
              <footer>
                <p>名单与赛程由网站维护；选择其他比赛浏览不会改变本场。</p>
                <Button
                  variant="primary"
                  loading={selecting}
                  disabled={selecting}
                  onClick={() => onSelect(match.matchId)}
                >
                  核对并载入本场
                </Button>
              </footer>
            </>
          ) : (
            <p>选择左侧比赛查看双方、名单和地图。</p>
          )}
        </section>
      </div>
    </div>
  );
}
