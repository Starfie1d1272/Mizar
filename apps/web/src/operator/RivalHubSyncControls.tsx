import { useState } from 'react';
import './rivalhub-sync.css';
import { useLocalRead, command } from '../preparation/client';
import { desktopInvoke } from '../workspace/client';
import { switchToRivalhubBp, useBpWorkspace } from '../bp/client';
import { Button, StatusBanner } from '../ui/primitives';

export function RivalHubSyncControls() {
  const connection = useLocalRead<{
    paired: boolean;
    activeMatchId: string | null;
    websiteUrl?: string | null;
    lastRefreshAt?: string | null;
    refreshError?: string | null;
  }>('/local/v1/rivalhub-connection', 3000);
  const { workspace } = useBpWorkspace();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  if (!connection?.paired || !connection.activeMatchId) return null;
  async function run(operation: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setMessage(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rivalhub-sync-controls" aria-label="在线比赛同步" aria-busy={busy}>
      <Button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = (await command('/operator/rivalhub/refresh')) as { message: string };
            return result.message;
          })
        }
      >
        刷新比赛资料与 BP
      </Button>
      {connection.websiteUrl ? (
        <a
          href={connection.websiteUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (!window.__TAURI_INTERNALS__) return;
            event.preventDefault();
            void run(async () => {
              await desktopInvoke('open_rivalhub_workbench', { url: connection.websiteUrl });
              return '已打开网站本场工作台；返回 Mizar 后可刷新比赛资料。';
            });
          }}
        >
          打开网站本场工作台
        </a>
      ) : null}
      {workspace?.pendingRivalhub ? (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await switchToRivalhubBp(
                workspace.contextRevision,
                workspace.pendingRivalhub!.revision,
              );
              return '已确认加载网站比赛资料。';
            })
          }
        >
          确认加载网站版本：{workspace.pendingRivalhub.entrants.a.name} vs{' '}
          {workspace.pendingRivalhub.entrants.b.name}
        </Button>
      ) : null}
      {connection.lastRefreshAt ? (
        <small>上次同步：{new Date(connection.lastRefreshAt).toLocaleTimeString('zh-CN')}</small>
      ) : null}
      {error || connection.refreshError ? (
        <StatusBanner tone="danger">{error || connection.refreshError}</StatusBanner>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </div>
  );
}
