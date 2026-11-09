import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopInvoke } from './client';
import { Button, Dialog } from '../ui/primitives';
import { syncHealthText, type SyncHealth } from './sync-health';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { ReviewDialog, closeReviewWindow, isReviewWindow } from './ReviewDialog';
import { SupportExport } from '../debug/SupportExport';

type Connection = {
  sourceReady?: boolean;
  sourceBlockedCode?: string | null;
  sourceBlockedReason?: string | null;
  sourceBlockedAction?: string | null;
  sourceCommandPending: boolean;
  paired: boolean;
  activeMatchId: string | null;
  activeMatchTitle?: string | null;
  contextRevision?: string | null;
  activeSourceMatchId: string | null;
  activeDeviceName: string | null;
  stoppedMatchId?: string | null;
  sourceState?: 'ready' | 'unavailable';
  sourceCleanup?: {
    pending: number;
    blocked: number;
    claimIntent: boolean;
    handoffPending: number;
    coverageUnknown?: number;
  } | null;
  lastRefreshAt?: string | null;
  refreshError?: string | null;
  syncHealth?: SyncHealth;
};
type SyncAction = { label: string; command?: string; path?: string; takeover?: boolean };
type SyncFeedback = {
  scope: string;
  command?: string;
  message: string;
  error: boolean;
  uncertain: boolean;
  afterReadSequence: number;
  refreshAt: string | null;
  confirmationRequired: boolean;
};
const scope = (value: Connection | null) =>
  JSON.stringify([value?.activeMatchId ?? null, value?.contextRevision ?? null]);

function feedbackResolved(feedback: SyncFeedback, connection: Connection): boolean {
  switch (feedback.command) {
    case '/operator/rivalhub/source/retry-stop':
    case '/operator/rivalhub/source/release': {
      const cleanup = connection.sourceCleanup;
      return Boolean(
        (feedback.command !== '/operator/rivalhub/source/retry-stop' || !feedback.error) &&
        connection.activeMatchId &&
        connection.stoppedMatchId === connection.activeMatchId &&
        connection.activeSourceMatchId !== connection.activeMatchId &&
        connection.sourceState === 'ready' &&
        cleanup &&
        cleanup.pending === 0 &&
        cleanup.blocked === 0 &&
        !cleanup.claimIntent &&
        cleanup.handoffPending === 0,
      );
    }
    case '/operator/rivalhub/refresh':
      return Boolean(
        !feedback.confirmationRequired &&
        connection.lastRefreshAt &&
        connection.lastRefreshAt !== feedback.refreshAt &&
        !connection.refreshError,
      );
    case '/operator/rivalhub/output/retry':
    case '/operator/rivalhub/source/claim':
    case '/operator/rivalhub/source/resume':
    case '/operator/rivalhub/source/retry':
      return connection.syncHealth?.status === 'healthy' && !connection.sourceBlockedReason;
    default:
      return false;
  }
}

function nextAction(connection: Connection): SyncAction | null {
  const reason = connection.syncHealth?.reason;
  if (connection.sourceBlockedCode === 'output_unavailable')
    return { label: '查看运行诊断', path: '/debug' };
  if (connection.sourceBlockedAction === 'output-retry')
    return { label: '重试保存同步记录', command: '/operator/rivalhub/output/retry' };
  if (!connection.paired || reason === 'authorization_expired' || reason === 'permission_denied')
    return { label: '连接网站', path: '/settings?tab=rivalhub' };
  if (connection.sourceBlockedReason) {
    switch (connection.sourceBlockedAction) {
      case 'connection':
        return { label: '检查游戏连接', path: '/settings?tab=gsi' };
      case 'roster':
        return { label: '核对本场名单', path: '/matches?tab=roster' };
      case 'match':
        return { label: '核对本场比赛', path: '/matches#series-binding' };
      case 'refresh':
        return { label: '刷新比赛资料', command: '/operator/rivalhub/refresh' };
      case 'production':
        return { label: '返回准备中心', path: '/' };
      default:
        return { label: '查看运行诊断', path: '/debug' };
    }
  }
  if (connection.sourceReady !== true || !connection.activeMatchId) return null;
  if (connection.activeDeviceName) return { label: '接管本场网站同步', takeover: true };
  if (connection.stoppedMatchId === connection.activeMatchId)
    return { label: '恢复本场网站同步', command: '/operator/rivalhub/source/resume' };
  if (reason === 'context_stale' || reason === 'context_conflict')
    return { label: '刷新比赛资料', command: '/operator/rivalhub/refresh' };
  if (reason === 'input_unavailable') return { label: '检查游戏连接', path: '/settings?tab=gsi' };
  if (['context_refreshing', 'context_reconfirming', 'continuity_waiting'].includes(reason ?? ''))
    return null;
  if (
    [
      'sequence_stale',
      'generation_fence',
      'epoch_fence',
      'authority_changed',
      'context_recovery_blocked',
      'reliable_needs_attention',
    ].includes(reason ?? '')
  )
    return { label: '核对本场比赛', path: '/matches#series-binding' };
  if (
    [
      'continuity_chain_missing',
      'idempotency_conflict',
      'invalid_schema',
      'map_start_rejected',
      'http_400',
    ].includes(reason ?? '')
  )
    return { label: '查看运行诊断', path: '/debug' };
  if (connection.activeSourceMatchId !== connection.activeMatchId)
    return connection.sourceCleanup?.claimIntent || connection.sourceCleanup?.pending
      ? { label: '恢复本场网站同步', command: '/operator/rivalhub/source/resume' }
      : { label: '开启本场网站同步', command: '/operator/rivalhub/source/claim' };
  return connection.syncHealth?.status === 'attention'
    ? { label: '重试网站同步', command: '/operator/rivalhub/source/retry' }
    : null;
}

function statusText(connection: Connection): string {
  if (
    (connection.sourceBlockedCode === 'output_unavailable' ||
      connection.sourceBlockedAction === 'output-retry') &&
    connection.sourceBlockedReason
  )
    return connection.sourceBlockedReason;
  if (!connection.paired) return '尚未连接网站。';
  if (['authorization_expired', 'permission_denied'].includes(connection.syncHealth?.reason ?? ''))
    return syncHealthText(connection.syncHealth);
  if (connection.sourceBlockedReason) return connection.sourceBlockedReason;
  if (connection.activeDeviceName) return `当前由 ${connection.activeDeviceName} 提供实时数据。`;
  if (connection.activeMatchId && connection.stoppedMatchId === connection.activeMatchId)
    return '本机网站同步已停止。';
  if (connection.activeSourceMatchId !== connection.activeMatchId || !connection.activeMatchId)
    return connection.syncHealth?.reason && connection.syncHealth.reason !== 'source_unavailable'
      ? syncHealthText(connection.syncHealth)
      : '尚未开启本场网站同步。';
  if (connection.syncHealth?.status === 'inactive' && !connection.syncHealth.reason)
    return '已开启网站同步，等待正式比赛数据。';
  return syncHealthText(connection.syncHealth);
}

export function RivalHubLiveSourcePanel({
  currentMatchTitle,
  compact = false,
}: {
  currentMatchTitle?: string | null;
  compact?: boolean;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const latest = useRef<Connection | null>(null);
  const [open, setOpen] = useState(!compact);
  const [takeover, setTakeover] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(false);
  const [feedback, setFeedback] = useState<SyncFeedback | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    readRequest.current?.abort();
    const request = new AbortController();
    readRequest.current = request;
    const sequence = ++readSequence.current;
    try {
      const response = await fetch('/local/v1/rivalhub-connection', {
        cache: 'no-store',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error('read_failed');
      const next = (await response.json()) as Connection;
      if (!mounted.current || sequence !== readSequence.current) return null;
      latest.current = next;
      setConnection(next);
      setReadError(false);
      setFeedback((previous) => {
        if (!previous || previous.scope !== scope(next)) return null;
        if (sequence <= previous.afterReadSequence) return previous;
        if (feedbackResolved(previous, next)) return null;
        return previous.uncertain ? { ...previous, uncertain: false } : previous;
      });
      return next;
    } catch {
      if (mounted.current && sequence === readSequence.current) setReadError(true);
      return null;
    } finally {
      if (readRequest.current === request) readRequest.current = null;
    }
  }, []);
  const invalidateReads = useCallback(() => {
    ++readSequence.current;
    readRequest.current?.abort();
    readRequest.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const initialRead = setTimeout(() => void read(), 0);
    const timer = setInterval(() => {
      if (!readRequest.current) void read();
    }, 3000);
    return () => {
      mounted.current = false;
      invalidateReads();
      clearTimeout(initialRead);
      clearInterval(timer);
    };
  }, [read, invalidateReads]);

  const navigate = async (path: string) => {
    if (window.__TAURI_INTERNALS__) {
      if (path === '/debug') await desktopInvoke('open_tool', { tool: 'diagnostics' });
      else {
        await desktopInvoke('open_main', { path });
        await closeReviewWindow();
      }
    } else if (!window.open(path, 'mizar-preparation')) {
      throw new Error('处理页面未能打开，请允许弹出窗口后重试。');
    }
  };
  const run = async (selected: SyncAction, target = latest.current) => {
    if (
      inFlight.current ||
      !target ||
      readError ||
      feedback?.uncertain ||
      latest.current?.sourceCommandPending ||
      scope(target) !== scope(latest.current)
    )
      return;
    if (selected.takeover) {
      setTakeover(target);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    invalidateReads();
    const originalScope = scope(target);
    let message = '';
    let failed = false;
    let rejected = false;
    let uncertain = false;
    let confirmationRequired = false;
    try {
      if (selected.path) await navigate(selected.path);
      else if (selected.command) {
        const signal = AbortSignal.timeout(30_000);
        const response = await fetch(selected.command, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            selected.command === '/operator/rivalhub/refresh'
              ? {}
              : {
                  matchId: target.activeMatchId,
                  contextRevision: target.contextRevision,
                  ...(selected.command === '/operator/rivalhub/source/claim' && takeover === target
                    ? { takeover: true }
                    : {}),
                },
          ),
          signal,
        });
        const body = (await response.json().catch((error: unknown) => {
          if (signal.aborted) throw error;
          return null;
        })) as { message?: string; pending?: boolean } | null;
        if (!response.ok) {
          rejected = true;
          throw new Error(body?.message ?? '网站同步操作未完成，请重试。');
        }
        confirmationRequired = body?.pending === true;
        message = selected.command.endsWith('/retry-stop')
          ? (body?.message ?? '停止交接重试已提交，请重新检查网站同步状态。')
          : selected.command.endsWith('/release')
            ? '已停止本机网站同步。'
            : selected.command.endsWith('/refresh') ||
                selected.command === '/operator/rivalhub/output/retry'
              ? (body?.message ?? '比赛资料已刷新。')
              : '操作已提交，等待网站接收本场新数据确认。';
      }
    } catch (error) {
      failed = true;
      uncertain = Boolean(selected.command && !rejected);
      message = uncertain
        ? '操作结果暂未确认，请重新检查状态。'
        : error instanceof Error
          ? error.message
          : '操作未完成，请重试。';
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        if (scope(latest.current) === originalScope && message)
          setFeedback({
            scope: originalScope,
            ...(selected.command ? { command: selected.command } : {}),
            message,
            error: failed,
            uncertain,
            afterReadSequence: readSequence.current,
            refreshAt: target.lastRefreshAt ?? null,
            confirmationRequired,
          });
        setTakeover(null);
        setBusy(false);
        if (selected.command) void read();
      }
    }
  };

  const currentScope = scope(connection);
  const isCurrentSource = Boolean(
    connection?.activeMatchId &&
    connection.activeSourceMatchId === connection.activeMatchId &&
    connection.stoppedMatchId !== connection.activeMatchId,
  );
  const hasStoppedSource = Boolean(
    connection?.activeMatchId &&
    connection.stoppedMatchId === connection.activeMatchId &&
    connection.activeSourceMatchId === connection.activeMatchId,
  );
  const primary = connection ? nextAction(connection) : null;
  const visibleFeedback = feedback?.scope === currentScope ? feedback : null;
  const pending = busy || Boolean(connection?.sourceCommandPending || visibleFeedback?.uncertain);
  const content = (
    <div className="workspace-rivalhub-source" aria-label="本场网站同步" aria-busy={busy}>
      {connection?.activeMatchTitle || currentMatchTitle ? (
        <small>当前比赛：{connection?.activeMatchTitle ?? currentMatchTitle}</small>
      ) : null}
      <p role="status">
        {readError
          ? '暂时无法读取网站同步状态，请重新检查。'
          : connection
            ? connection.sourceCommandPending
              ? '正在处理网站同步…'
              : statusText(connection)
            : '正在读取网站同步状态…'}
      </p>
      {(connection?.sourceCleanup?.coverageUnknown ?? 0) > 0 ? (
        <p role="status">
          部分历史网站数据的完整性待核对，原记录已保留。本机播出不受影响，请导出诊断并核对网站赛果。
        </p>
      ) : null}
      {readError || visibleFeedback?.uncertain ? (
        <Button onClick={() => void read()}>重新检查状态</Button>
      ) : primary ? (
        <Button
          variant="primary"
          disabled={pending}
          loading={busy}
          onClick={() => void run(primary)}
        >
          {primary.label}
        </Button>
      ) : null}
      {isCurrentSource ? (
        <Button
          disabled={pending || readError}
          onClick={() =>
            void run({ label: '停止本机网站同步', command: '/operator/rivalhub/source/release' })
          }
        >
          停止本机网站同步
        </Button>
      ) : null}
      {hasStoppedSource ? (
        <Button
          disabled={pending || readError || connection?.sourceState === 'unavailable'}
          onClick={() =>
            void run({ label: '重试停止交接', command: '/operator/rivalhub/source/retry-stop' })
          }
        >
          重试停止交接
        </Button>
      ) : null}
      {visibleFeedback ? (
        <p role={visibleFeedback.error ? 'alert' : 'status'}>{visibleFeedback.message}</p>
      ) : null}
      <details>
        <summary>比赛资料与诊断</summary>
        <RivalHubSyncControls />
        <SupportExport />
      </details>
      <Dialog
        open={Boolean(takeover && scope(takeover) === currentScope)}
        title="接管本场网站同步"
        onClose={() => setTakeover(null)}
        canClose={() => !busy}
        showCloseButton={false}
        actions={
          <>
            <Button disabled={busy} onClick={() => setTakeover(null)}>
              取消
            </Button>
            <Button
              disabled={pending || readError || connection?.sourceReady !== true}
              loading={busy}
              onClick={() =>
                void run(
                  { label: '确认接管', command: '/operator/rivalhub/source/claim' },
                  takeover,
                )
              }
            >
              确认接管
            </Button>
          </>
        }
      >
        <p>
          当前由 {takeover?.activeDeviceName}{' '}
          提供本场数据。接管后改由本机同步，请先与该设备的操作者确认。
        </p>
      </Dialog>
    </div>
  );
  if (!compact && !isReviewWindow()) return content;
  return (
    <>
      {compact ? (
        <Button onClick={() => setOpen(true)}>
          {connection?.syncHealth?.status === 'healthy' && !readError
            ? '比赛同步 · 接收中'
            : '比赛同步'}
        </Button>
      ) : null}
      <ReviewDialog
        kind="sync"
        open={open}
        title="本场网站同步"
        onClose={() => setOpen(false)}
        canClose={() => !busy}
      >
        {content}
      </ReviewDialog>
    </>
  );
}

/** The fixed native sync route never depends on an attention incident. */
export function RivalHubSyncReview() {
  return <RivalHubLiveSourcePanel />;
}
