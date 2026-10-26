import { useEffect, useRef, useState } from 'react';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { LibraryWorkspace } from '../patterns/LibraryWorkspace';
import { LibraryMatchDetails, libraryMatchTime } from '../preparation/LibraryMatchDetails';
import { Button, Select, StatusBanner } from '../ui';
import { sortWebsiteMatches } from './website-schedule-order';

export type WebsiteSchedule = {
  competition: { name: string };
  viewer?: { userId: string; displayName: string };
  matches: {
    matchId: string;
    assignedToViewer?: boolean;
    scheduledAt: string | null;
    status?: 'scheduled' | 'in_progress' | 'finished' | 'cancelled';
    startedAt?: string | null;
    completedAt?: string | null;
    entrantA: { name: string };
    entrantB: { name: string };
    format: string;
    stageLabel?: string | null;
  }[];
  library?: {
    scopeId?: string;
    scheduleWarning?: string | null;
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
  const visibilityMarker = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const change = () => {
      const marker = visibilityMarker.current;
      setVisible(
        Boolean(marker) &&
          document.visibilityState !== 'hidden' &&
          !marker?.closest('details:not([open]), [hidden]') &&
          (marker?.checkVisibility?.({ checkVisibilityCSS: true }) ?? true),
      );
    };
    change();
    document.addEventListener('visibilitychange', change);
    document.addEventListener('toggle', change, true);
    return () => {
      document.removeEventListener('visibilitychange', change);
      document.removeEventListener('toggle', change, true);
    };
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const matches = sortWebsiteMatches(schedule.matches);
  const match = matches.find((row) => row.matchId === selected) ?? matches[0];
  const matchId = match?.matchId;
  const scopeId = schedule.library?.scopeId;
  const [detail, setDetail] = useState<{
    scopeId: string | undefined;
    matchId: string;
    entry: NonNullable<WebsiteSchedule['library']>['entries'][string] | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  useEffect(() => {
    if (!matchId || !visible) return;
    const controller = new AbortController();
    let running = false;
    const load = async (fresh: boolean) => {
      if (running) return;
      running = true;
      setDetail((previous) => ({
        scopeId,
        matchId,
        entry:
          previous && previous.scopeId === scopeId && previous.matchId === matchId
            ? previous.entry
            : null,
        error: null,
        loading: true,
      }));
      try {
        const response = await fetch(
          `/local/v1/rivalhub-library/${encodeURIComponent(matchId)}?fresh=${fresh ? 1 : 0}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('完整资料暂时无法获取，请重试。');
        const result = (await response.json()) as {
          entry: NonNullable<WebsiteSchedule['library']>['entries'][string] | null;
          error: string | null;
        };
        if (!controller.signal.aborted) setDetail({ scopeId, matchId, ...result, loading: false });
      } catch {
        if (!controller.signal.aborted)
          setDetail((previous) => ({
            scopeId,
            matchId,
            entry:
              previous && previous.scopeId === scopeId && previous.matchId === matchId
                ? previous.entry
                : null,
            error: '完整资料暂时无法获取。未浏览过的资料离线不可用，请连接网站后重试。',
            loading: false,
          }));
      } finally {
        running = false;
      }
    };
    void load(true);
    const timer = setInterval(() => void load(false), 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [matchId, refreshRevision, scopeId, visible]);
  const currentDetail =
    detail && detail.scopeId === scopeId && detail.matchId === matchId ? detail : null;
  const entry = currentDetail?.entry;
  const matchDocument = entry?.document;
  return (
    <>
      {schedule.library?.scheduleWarning ? (
        <StatusBanner tone="warning">{schedule.library.scheduleWarning}</StatusBanner>
      ) : null}
      {currentDetail?.error ? (
        <StatusBanner tone="warning">{currentDetail.error}</StatusBanner>
      ) : null}
      {schedule.library?.error ? (
        <StatusBanner tone="warning">
          {schedule.library.error} 浏览不受影响，载入前会重新核对网站资料。
        </StatusBanner>
      ) : null}
      <LibraryWorkspace
        status={
          <>
            {schedule.viewer ? <span>授权账号：{schedule.viewer.displayName}</span> : null}
            <span ref={visibilityMarker}>过去两周 · 未来两周 · {schedule.matches.length} 场</span>
            <span>
              上次同步{' '}
              {schedule.library?.syncedAt
                ? libraryMatchTime(schedule.library.syncedAt)
                : '尚未同步'}
              {schedule.library?.refreshing ? ' · 更新中' : ''}
            </span>
          </>
        }
        items={matches.map((row) => ({
          id: row.matchId,
          title: `${row.entrantA.name} vs ${row.entrantB.name}`,
          summary: `${libraryMatchTime(row.scheduledAt)} · ${row.format.toUpperCase()}${row.stageLabel ? ` · ${row.stageLabel}` : ''}`,
          status: `${row.assignedToViewer === true ? '我认领的 · ' : ''}${row.matchId === activeMatchId ? '当前本场' : '候选，尚未载入'}`,
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
            loading={refreshing || Boolean(currentDetail?.loading)}
            disabled={refreshing || Boolean(currentDetail?.loading)}
            onClick={() => {
              onRefresh();
              setRefreshRevision((revision) => revision + 1);
            }}
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
        {matchDocument ? (
          <LibraryMatchDetails document={matchDocument} />
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
              {currentDetail?.error ?? '正在加载本场名单与地图资料…'}
            </StatusBanner>
          </>
        ) : (
          <p>选择左侧比赛查看双方、名单和地图。</p>
        )}
      </LibraryWorkspace>
    </>
  );
}
