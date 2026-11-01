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
  activeSourceMatchId: string | null;
  activeDeviceName: string | null;
  stoppedMatchId?: string | null;
  syncHealth?: SyncHealth;
};

const MAX_AUTO_CLAIM_ATTEMPTS = 5;
const MIN_AUTO_CLAIM_INTERVAL_MS = 2_000;

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

  const autoClaimRef = useRef<{
    matchId: string | null;
    attempts: number;
    lastAttemptAt: number;
    settled: boolean;
  }>({
    matchId: null,
    attempts: 0,
    lastAttemptAt: 0,
    settled: false,
  });
  const inFlightRef = useRef(false);
  const userReleasedRef = useRef<string | null>(null);
  const wasReadyRef = useRef(false);

  const activeMatchId = connection?.activeMatchId ?? null;
  const isSource = Boolean(activeMatchId && connection?.activeSourceMatchId === activeMatchId);
  const hasOtherSource = Boolean(connection?.activeDeviceName);

  useEffect(() => {
    if (autoClaimRef.current.matchId !== null && autoClaimRef.current.matchId !== activeMatchId) {
      autoClaimRef.current = {
        matchId: activeMatchId,
        attempts: 0,
        lastAttemptAt: 0,
        settled: false,
      };
      userReleasedRef.current = null;
    } else if (autoClaimRef.current.matchId === null && activeMatchId !== null) {
      autoClaimRef.current.matchId = activeMatchId;
    }
    if (activeMatchId && (isSource || hasOtherSource)) {
      autoClaimRef.current.settled = true;
    }
  }, [activeMatchId, isSource, hasOtherSource]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch('/local/v1/rivalhub-connection', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as Connection;
        if (cancelled) return;
        setConnection(next);
        if (next.sourceReady === true && !wasReadyRef.current && !userReleasedRef.current) {
          autoClaimRef.current.attempts = 0;
          autoClaimRef.current.settled = false;
        }
        wasReadyRef.current = next.sourceReady !== false;

        const targetMatchId = next.activeMatchId;
        if (
          !targetMatchId ||
          next.sourceReady === false ||
          !next.paired ||
          next.stoppedMatchId === targetMatchId ||
          next.activeSourceMatchId === targetMatchId ||
          Boolean(next.activeDeviceName) ||
          userReleasedRef.current === targetMatchId ||
          autoClaimRef.current.settled ||
          autoClaimRef.current.attempts >= MAX_AUTO_CLAIM_ATTEMPTS ||
          inFlightRef.current ||
          Date.now() - autoClaimRef.current.lastAttemptAt < MIN_AUTO_CLAIM_INTERVAL_MS
        ) {
          return;
        }

        inFlightRef.current = true;
        autoClaimRef.current.attempts++;
        autoClaimRef.current.lastAttemptAt = Date.now();

        try {
          const claimResponse = await fetch('/operator/rivalhub/source/claim', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (!claimResponse.ok && !cancelled) {
            const failure = (await claimResponse.json().catch(() => null)) as {
              message?: string;
            } | null;
            onMessage(failure?.message ?? '自动认领数据源失败，可手动重试。');
          }
          if (claimResponse.ok && !cancelled) {
            const updated = (await claimResponse.json()) as Connection;
            if (cancelled) return;
            setConnection({ ...next, ...updated });
            autoClaimRef.current.settled = true;
            if (updated.activeSourceMatchId === targetMatchId) {
              onMessage('本机已成为本场实时数据源。');
            }
          }
        } finally {
          inFlightRef.current = false;
        }
      } catch {
        // Quiet
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeMatchId, onMessage]);

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
      const response = await fetch('/operator/rivalhub/source/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? '认领数据源失败。');
      }
      const next = (await response.json()) as Connection;
      setConnection((old) => ({ ...old, ...next }));
      autoClaimRef.current.settled = true;
      if (targetMatchId !== null && next.activeSourceMatchId === targetMatchId) {
        userReleasedRef.current = null;
        onMessage('本机已成为本场实时数据源。');
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
      autoClaimRef.current.settled = true;
      userReleasedRef.current = null;
      setTakeoverOpen(false);
      onMessage('已接管为本场数据源。');
    });

  const handleRelease = () =>
    run(async () => {
      userReleasedRef.current = connection?.activeMatchId ?? null;
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
    connection.activeMatchId && connection.activeSourceMatchId === connection.activeMatchId,
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
        {isCurrentSource ? (
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
      ) : connection.activeDeviceName ? (
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
          成为本场数据源
        </Button>
      )}
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
