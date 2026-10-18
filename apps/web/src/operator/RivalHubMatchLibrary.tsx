import { useState } from 'react';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { LibraryWorkspace } from '../patterns/LibraryWorkspace';
import { LibraryMatchDetails, libraryMatchTime } from '../preparation/LibraryMatchDetails';
import { Button, Select, StatusBanner } from '../ui';

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

/** Adapts website cache and commands to the same browser used by local matches. */
export function RivalHubMatchLibrary({
  schedule,
  selecting,
  onSelect,
  activeMatchId,
  refreshing,
  onRefresh,
}: {
  schedule: WebsiteSchedule;
  selecting: boolean;
  onSelect: (id: string) => void;
  activeMatchId: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const match = schedule.matches.find((row) => row.matchId === selected) ?? schedule.matches[0];
  const entry = match ? schedule.library?.entries[match.matchId] : null;
  const document = entry?.document;
  return (
    <>
      {schedule.library?.error ? (
        <StatusBanner tone="warning">
          {schedule.library.error} 浏览不受影响，载入前会重新核对网站资料。
        </StatusBanner>
      ) : null}
      <LibraryWorkspace
        status={
          <>
            <span>过去两周 · 未来两周 · {schedule.matches.length} 场</span>
            <span>
              上次同步{' '}
              {schedule.library?.syncedAt
                ? libraryMatchTime(schedule.library.syncedAt)
                : '尚未同步'}
              {schedule.library?.refreshing ? ' · 更新中' : ''}
            </span>
          </>
        }
        items={schedule.matches.map((row) => ({
          id: row.matchId,
          title: `${row.entrantA.name} vs ${row.entrantB.name}`,
          summary: `${libraryMatchTime(row.scheduledAt)} · ${row.format.toUpperCase()}${row.stageLabel ? ` · ${row.stageLabel}` : ''}`,
          status: row.matchId === activeMatchId ? '当前本场' : '候选，尚未载入',
        }))}
        selectedId={match?.matchId}
        onSelect={setSelected}
        emptyMessage="这个时间范围内暂无比赛。网站新增赛程后会自动出现在这里。"
        browserHeader={
          <Select label="浏览赛事" defaultValue="website">
            <option value="website">
              {schedule.competition.name} · {schedule.matches.length} 场
            </option>
          </Select>
        }
        browserActions={
          <Button
            aria-label="刷新比赛"
            loading={refreshing}
            disabled={refreshing}
            onClick={onRefresh}
          >
            刷新比赛
          </Button>
        }
        header={
          match ? (
            <>
              <span>{match.matchId === activeMatchId ? '当前本场' : '候选比赛'}</span>
              <small>网站资料 · 名单与赛程由网站维护</small>
            </>
          ) : null
        }
        footer={
          match ? (
            <>
              <small>
                {entry ? `最近核对 ${libraryMatchTime(entry.checkedAt)} · ` : ''}浏览不会切换本场
              </small>
              {match.matchId === activeMatchId ? (
                <Button variant="primary" onClick={() => window.location.assign('/?tab=match')}>
                  前往本场准备
                </Button>
              ) : (
                <Button
                  variant="primary"
                  loading={selecting}
                  disabled={selecting}
                  onClick={() => onSelect(match.matchId)}
                >
                  核对并载入本场
                </Button>
              )}
            </>
          ) : null
        }
      >
        {document ? (
          <LibraryMatchDetails document={document} />
        ) : match ? (
          <>
            <h2>
              {match.entrantA.name} vs {match.entrantB.name}
            </h2>
            <p>
              {libraryMatchTime(match.scheduledAt)} · {match.format.toUpperCase()} ·{' '}
              {match.stageLabel ?? '阶段待定'}
            </p>
            <StatusBanner tone="info">
              {schedule.library?.error
                ? '完整资料暂未缓存，可稍后重试。'
                : '正在缓存本场名单与地图资料…'}
            </StatusBanner>
          </>
        ) : (
          <p>选择左侧比赛查看双方、名单和地图。</p>
        )}
      </LibraryWorkspace>
    </>
  );
}
