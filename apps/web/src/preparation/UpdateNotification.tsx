import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../ui';
import { useLocalRead } from './client';
import type { UpdateStatus } from './UpdateSettings';
import './updates.css';

type Notification = { version: string; notes: string };

function canInterrupt() {
  return (
    document.hasFocus() &&
    document.visibilityState === 'visible' &&
    !document.querySelector('dialog[open]') &&
    !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')
  );
}

function DesktopUpdateNotification() {
  const status = useLocalRead<UpdateStatus>('/local/v1/updates', 3000);
  const [notice, setNotice] = useState<Notification | null>(null);
  const claiming = useRef(false);
  const claimedVersion = useRef<string | null>(null);
  useEffect(() => {
    if (
      !status?.notificationPending ||
      !status.notificationSafe ||
      !status.candidate ||
      claimedVersion.current === status.candidate.version ||
      notice ||
      claiming.current ||
      !canInterrupt()
    )
      return;
    let active = true;
    claiming.current = true;
    const request = new AbortController();
    void fetch('/operator/updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify', version: status.candidate.version }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const result = (await response.json()) as UpdateStatus & {
          notification: Notification | null;
        };
        if (result.notification || !result.notificationPending)
          claimedVersion.current = status.candidate?.version ?? null;
        if (active && result.notificationSafe && result.notification && canInterrupt())
          setNotice(result.notification);
      })
      .catch(() => undefined)
      .finally(() => {
        claiming.current = false;
      });
    return () => {
      active = false;
      request.abort();
    };
  }, [status, notice]);
  const close = () => setNotice(null);
  return (
    <Dialog
      open={notice !== null && status?.notificationSafe === true}
      title={notice ? `发现新版 v${notice.version}` : '应用更新'}
      onClose={close}
    >
      <p>更新已通过来源验证，可以查看更新说明并决定是否更新。</p>
      <div className="settings-update-notes">{notice?.notes}</div>
      <div className="preparation-actions">
        <Button variant="primary" onClick={() => window.location.assign('/settings?tab=advanced')}>
          查看更新
        </Button>
        <Button onClick={close}>稍后</Button>
      </div>
    </Dialog>
  );
}

export function UpdateNotification() {
  return window.__TAURI_INTERNALS__ ? <DesktopUpdateNotification /> : null;
}
