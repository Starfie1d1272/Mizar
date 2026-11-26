import { useEffect, useState } from 'react';
import { Button } from '../ui';
import {
  installDesktopUpdate,
  openUpdateReleasePage,
  sendUpdateAction,
  useUpdateStatus,
} from './updates-client';

export function SidebarUpdateEntry() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const context = useUpdateStatus();
  const status = context?.status ?? null;
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');

  const mode = status?.staged
    ? 'staged'
    : status &&
        !status.automatic &&
        status.candidate &&
        !status.manual &&
        status.activity !== 'downloading'
      ? 'download'
      : status?.manual && status.candidate
        ? 'manual'
        : null;

  const targetVersion =
    mode === 'staged' ? status?.staged?.version : (status?.candidate?.version ?? null);

  useEffect(() => {
    setError('');
  }, [mode, targetVersion, status?.installBlockedReason]);

  if (!desktop || !status || !mode || !targetVersion) return null;

  const blocked = mode === 'staged' && Boolean(status.installBlockedReason);
  const label = mode === 'staged' ? '更新已就绪' : '发现新版本';
  const actionLabel =
    mode === 'staged'
      ? acting
        ? '正在更新…'
        : '重启并更新'
      : mode === 'download'
        ? '下载更新'
        : '前往下载';

  const handleAction = async () => {
    if (acting || blocked) return;
    setActing(true);
    setError('');
    try {
      if (mode === 'staged') {
        await installDesktopUpdate();
      } else if (mode === 'download') {
        const next = await sendUpdateAction('download');
        context?.setStatus(next);
      } else {
        await openUpdateReleasePage(targetVersion);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。');
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="product-sidebar-update">
      <div className="product-sidebar-update__meta">
        <span className="product-sidebar-update__label">{label}</span>
        <span className="product-sidebar-update__version">v{targetVersion}</span>
      </div>
      <Button
        variant={mode === 'staged' ? 'primary' : 'default'}
        disabled={acting || blocked}
        aria-busy={acting || undefined}
        onClick={() => void handleAction()}
      >
        {actionLabel}
      </Button>
      {mode === 'staged' && status.installBlockedReason ? (
        <p className="product-sidebar-update__reason">{status.installBlockedReason}</p>
      ) : null}
      {error ? (
        <p className="product-sidebar-update__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
