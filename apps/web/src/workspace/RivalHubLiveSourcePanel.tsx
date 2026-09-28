import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/primitives';

type Connection = {
  paired: boolean;
  competitionId: string | null;
  displayName: string | null;
  activeMatchId: string | null;
  activeSourceMatchId: string | null;
  activeDeviceName: string | null;
};

const MAX_AUTO_CLAIM_ATTEMPTS = 5;
const MIN_AUTO_CLAIM_INTERVAL_MS = 2_000;

export function RivalHubLiveSourcePanel({
  action,
  onMessage,
  currentMatchTitle,
}: {
  action: (run: () => Promise<unknown>) => Promise<void>;
  onMessage: (message: string) => void;
  currentMatchTitle?: string | null;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);

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

        const targetMatchId = next.activeMatchId;
        if (
          !targetMatchId ||
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
          if (claimResponse.ok && !cancelled) {
            const updated = (await claimResponse.json()) as Connection;
            if (cancelled) return;
            setConnection(updated);
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

  const handleClaim = () =>
    action(async () => {
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
      setConnection(next);
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
    action(async () => {
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
      setConnection(next);
      autoClaimRef.current.settled = true;
      userReleasedRef.current = null;
      onMessage('已接管为本场数据源。');
    });

  const handleRelease = () =>
    action(async () => {
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
      setConnection(next);
      onMessage('已停止作为数据源。');
    });

  if (!connection?.paired || !connection?.activeMatchId) {
    return null;
  }

  const isCurrentSource = connection.activeSourceMatchId === connection.activeMatchId;

  return (
    <div className="workspace-rivalhub-source" aria-label="实时数据源状态">
      <div className="workspace-rivalhub-source-status">
        {currentMatchTitle ? <small>当前比赛：{currentMatchTitle}</small> : null}
        <small>实时数据源</small>
        {isCurrentSource ? (
          <p>本机正在提供实时数据</p>
        ) : connection.activeDeviceName ? (
          <p>当前由 {connection.activeDeviceName} 提供实时数据</p>
        ) : (
          <p>当前暂无数据源</p>
        )}
      </div>
      {isCurrentSource ? (
        <Button variant="secondary" onClick={() => void handleRelease()}>
          停止作为数据源
        </Button>
      ) : connection.activeDeviceName ? (
        <Button variant="primary" onClick={() => void handleTakeover()}>
          接管为本场数据源
        </Button>
      ) : (
        <Button variant="primary" onClick={() => void handleClaim()}>
          成为本场数据源
        </Button>
      )}
    </div>
  );
}
