import { useEffect, useState } from 'react';
import { desktopInvoke } from './client';
import { Button } from '../ui/primitives';
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

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/local/v1/rivalhub-connection', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('unavailable');
        const next = (await response.json()) as Connection;
        if (active) setConnection(next);
      } catch {
        if (active) setConnection(null);
      } finally {
        if (active) timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

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
      setConnection((old) => ({ ...old, ...next }));
      if (targetMatchId !== null && next.activeSourceMatchId === targetMatchId) {
        onMessage('本机已成为本场实时数据源。');
      } else if (next.activeDeviceName) {
        onMessage(`当前由 ${next.activeDeviceName} 提供实时数据。`);
      } else {
        onMessage('本场实时数据源状态已更新。');
      }
    });

  const handleTakeover = () =>
    action(async () => {
      if (!window.confirm('接管其他设备的网站数据源？节目自动 / 手动控制不会改变。')) return;
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
      onMessage('已接管为本场数据源。');
    });

  const handleRelease = () =>
    action(async () => {
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
      onMessage('已停止提供网站数据。');
    });

  if (!connection) return <span role="status">网站数据源 · 无法确认</span>;
  if (!connection.paired) {
    return (
      <a
        href="/settings?tab=rivalhub"
        onClick={(event) => {
          if (!window.__TAURI_INTERNALS__) return;
          event.preventDefault();
          void action(() => desktopInvoke('open_main', { path: '/settings?tab=rivalhub' }));
        }}
      >
        连接 RivalHub 以推送实时数据
      </a>
    );
  }

  const isCurrentSource = Boolean(
    connection.activeMatchId && connection.activeSourceMatchId === connection.activeMatchId,
  );

  return (
    <div className="workspace-rivalhub-source" data-compact={compact} aria-label="实时数据源状态">
      {compact ? (
        <Button
          onClick={() =>
            void action(async () => {
              if (window.__TAURI_INTERNALS__)
                await desktopInvoke('open_main', { path: '/matches' });
              else window.open('/matches', 'mizar-match');
            })
          }
        >
          比赛同步
        </Button>
      ) : (
        <RivalHubSyncControls />
      )}
      {connection.sourceBlockedReason ? (
        <span role="status" title={connection.sourceBlockedReason}>
          {compact ? '推送待恢复，请打开比赛同步' : connection.sourceBlockedReason}
        </span>
      ) : null}
      {!compact ? (
        <div className="workspace-rivalhub-source-status">
          {currentMatchTitle ? <small>当前比赛：{currentMatchTitle}</small> : null}
          <small>实时数据源</small>
          {isCurrentSource ? (
            <p>
              {connection.sourceReady === false ? '本机已认领，推送暂停' : '本机正在提供实时数据'}
            </p>
          ) : connection.activeDeviceName ? (
            <p>当前由 {connection.activeDeviceName} 提供实时数据</p>
          ) : (
            <p>当前暂无数据源</p>
          )}
        </div>
      ) : null}
      {isCurrentSource ? (
        <Button
          variant="secondary"
          title={connection.sourceReady === false ? '本机已认领，推送暂停' : '本机正在提供实时数据'}
          onClick={() => void handleRelease()}
        >
          停止提供网站数据
        </Button>
      ) : connection.activeDeviceName ? (
        <Button
          variant="primary"
          title={`当前由 ${connection.activeDeviceName} 提供实时数据`}
          onClick={() => void handleTakeover()}
        >
          接管为本场数据源
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={connection.sourceReady === false || !connection.activeMatchId}
          onClick={() => void handleClaim()}
        >
          恢复提供网站数据
        </Button>
      )}
    </div>
  );
}
