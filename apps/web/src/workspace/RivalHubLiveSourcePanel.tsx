import { useEffect, useRef, useState } from 'react';
import { desktopInvoke } from './client';
import { Button, Dialog } from '../ui/primitives';
import { syncHealthText, type SyncHealth } from './SyncHealthAlert';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';

type Connection = {
  sourceReady?: boolean;
  sourceBlockedReason?: string | null;
  paired: boolean;
  competitionId: string | null;
  displayName: string | null;
  activeMatchId: string | null;
  contextRevision?: string | null;
  activeSourceMatchId: string | null;
  activeDeviceName: string | null;
  stoppedMatchId?: string | null;
  syncHealth?: SyncHealth;
};

export function RivalHubLiveSourcePanel({
  action,
  onMessage,
  currentMatchTitle,
  compact = false,
}: {
  action: (run: () => Promise<unknown>) => Promise<void>;
  onMessage: (message: string) => void;
  currentMatchTitle?: string | null;
  compact?: boolean;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const inFlightRef = useRef(false);
  const activeMatchId = connection?.activeMatchId ?? null;
  const stopped = Boolean(activeMatchId && connection?.stoppedMatchId === activeMatchId);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch('/local/v1/rivalhub-connection', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as Connection;
        if (!cancelled) setConnection(next);
      } catch {
        /* Keep the last read-only view; entering a page never claims authority. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const run = async (operation: () => Promise<unknown>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      await action(operation);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };
  const handleClaim = () =>
    run(async () => {
      const targetMatchId = connection?.activeMatchId ?? null;
      const response = await fetch(
        stopped ? '/operator/rivalhub/source/resume' : '/operator/rivalhub/source/claim',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stopped
            ? JSON.stringify({
                matchId: targetMatchId,
                contextRevision: connection?.contextRevision,
              })
            : '{}',
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? '认领数据源失败。');
      }
      const next = (await response.json()) as Connection;
      setConnection((old) => ({ ...old, ...next }));
      if (targetMatchId !== null && next.activeSourceMatchId === targetMatchId) {
        onMessage('已请求网站同步，等待本场开始确认与实际数据接收。');
      } else if (next.activeDeviceName) {
        onMessage(`当前由 ${next.activeDeviceName} 提供实时数据。`);
      } else {
        onMessage('本场实时数据源状态已更新。');
      }
    });

  const handleTakeover = () =>
    run(async () => {
      const response = await fetch('/operator/rivalhub/source/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeover: true }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? '接管数据源失败。');
      }
      const next = (await response.json()) as Connection;
      setConnection((old) => ({ ...old, ...next }));
      setTakeoverOpen(false);
      onMessage('认领已确认，等待本场开始确认与实际数据接收。');
    });

  const handleRelease = () =>
    run(async () => {
      const response = await fetch('/operator/rivalhub/source/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? '停止数据源未确认。');
      }
      const next = (await response.json()) as Connection;
      // Commands return connection state, without the active match added by polling.
      // Keep that context so release does not look like switching away from this match.
      setConnection((old) => ({ ...old, ...next }));
      onMessage('已停止作为数据源。');
    });

  if (!connection?.paired && compact) {
    return (
      <Button
        onClick={() =>
          void action(async () => {
            if (window.__TAURI_INTERNALS__)
              await desktopInvoke('open_main', { path: '/settings?tab=rivalhub' });
            else window.open('/settings?tab=rivalhub', 'mizar-preparation');
          })
        }
      >
        连接 RivalHub
      </Button>
    );
  }

  if (!connection?.paired) {
    return (
      <a
        href="/settings?tab=rivalhub"
        onClick={(event) => {
          if (!window.__TAURI_INTERNALS__) return;
          event.preventDefault();
          void action(() => desktopInvoke('open_main', { path: '/settings?tab=rivalhub' }));
        }}
      >
        {compact ? '连接 RivalHub' : '连接 RivalHub 以推送实时数据'}
      </a>
    );
  }

  const isCurrentSource = Boolean(
    !stopped &&
    connection.activeMatchId &&
    connection.activeSourceMatchId === connection.activeMatchId,
  );

  if (compact) {
    return (
      <Button
        title={connection.sourceBlockedReason || syncHealthText(connection.syncHealth)}
        onClick={() =>
          void action(async () => {
            if (window.__TAURI_INTERNALS__) await desktopInvoke('open_main', { path: '/matches' });
            else window.open('/matches', 'mizar-match');
          })
        }
      >
        {connection.sourceBlockedReason ? '比赛同步 · 待处理' : '比赛同步'}
      </Button>
    );
  }

  return (
    <div className="workspace-rivalhub-source" data-compact={compact} aria-label="实时数据源状态">
      <RivalHubSyncControls />
      {connection.sourceBlockedReason ? (
        <span role="status">{connection.sourceBlockedReason}</span>
      ) : null}
      <div className="workspace-rivalhub-source-status">
        {currentMatchTitle ? <small>当前比赛：{currentMatchTitle}</small> : null}
        <small>实时数据源</small>
        {stopped ? (
          <p>
            网站同步已停止，可恢复本场。
            {connection.activeDeviceName
              ? ` 当前由 ${connection.activeDeviceName} 提供实时数据。`
              : ''}
          </p>
        ) : isCurrentSource ? (
          <p>{syncHealthText(connection.syncHealth)}</p>
        ) : connection.activeDeviceName ? (
          <p>当前由 {connection.activeDeviceName} 提供实时数据</p>
        ) : (
          <p>当前暂无数据源</p>
        )}
      </div>
      {isCurrentSource ? (
        <Button
          variant="secondary"
          disabled={busy}
          title={syncHealthText(connection.syncHealth)}
          onClick={() => void handleRelease()}
        >
          停止作为数据源
        </Button>
      ) : connection.activeDeviceName && !stopped ? (
        <Button
          variant="primary"
          disabled={busy}
          title={`当前由 ${connection.activeDeviceName} 提供实时数据`}
          onClick={() => setTakeoverOpen(true)}
        >
          接管为本场数据源
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={busy || connection.sourceReady === false || !connection.activeMatchId}
          onClick={() => void handleClaim()}
        >
          {stopped ? '恢复本场网站同步' : '开启本场网站同步'}
        </Button>
      )}
      {stopped && connection.activeDeviceName ? (
        <Button variant="secondary" disabled={busy} onClick={() => setTakeoverOpen(true)}>
          接管其他设备来源
        </Button>
      ) : null}
      <Dialog
        open={takeoverOpen}
        title="接管本场数据源"
        onClose={() => setTakeoverOpen(false)}
        canClose={() => !busy}
        showCloseButton={false}
        actions={
          <>
            <Button disabled={busy} onClick={() => setTakeoverOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} aria-busy={busy} onClick={() => void handleTakeover()}>
              确认接管
            </Button>
          </>
        }
      >
        <p>
          当前数据源归属：{connection.activeDeviceName}
          。接管后由本机提供本场数据，请先与该设备的操作者确认。
        </p>
      </Dialog>
    </div>
  );
}
