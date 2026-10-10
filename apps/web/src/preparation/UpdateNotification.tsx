import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [dismissed, setDismissed] = useState<string | null>(null);
  const latest = useRef(status);
  const request = useRef<AbortController | null>(null);
  const acknowledging = useRef(false);
  useEffect(() => {
    latest.current = status;
  }, [status]);
  // Polling changes do not cancel a still-valid read; only unmount does.
  useEffect(() => () => request.current?.abort(), []);
  const acknowledge = useCallback(async (version: string) => {
    if (acknowledging.current) return;
    acknowledging.current = true;
    try {
      await fetch('/operator/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss-notification', version }),
        keepalive: true,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* Retry on the next status poll, without a background error dialog. */
    } finally {
      acknowledging.current = false;
    }
  }, []);
  useEffect(() => {
    if (!status?.notificationPending || !status.candidate) return;
    const version = status.candidate.version;
    if (dismissed === version) {
      void acknowledge(version);
      return;
    }
    if (
      !status.notificationSafe ||
      notice?.version === version ||
      request.current ||
      !canInterrupt()
    )
      return;
    const pending = new AbortController();
    request.current = pending;
    void fetch('/operator/updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify', version }),
      signal: AbortSignal.any([pending.signal, AbortSignal.timeout(8000)]),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const result = (await response.json()) as UpdateStatus & {
          notification: Notification | null;
        };
        if (
          !pending.signal.aborted &&
          result.notificationSafe &&
          result.notification &&
          result.candidate?.version === version &&
          latest.current?.notificationSafe &&
          latest.current.candidate?.version === version &&
          canInterrupt()
        )
          setNotice(result.notification);
      })
      .catch(() => undefined)
      .finally(() => {
        if (request.current === pending) request.current = null;
      });
  }, [status, notice, dismissed, acknowledge]);
  const open =
    notice !== null &&
    notice.version === status?.candidate?.version &&
    dismissed !== notice.version &&
    status.notificationSafe === true &&
    document.hasFocus() &&
    document.visibilityState === 'visible';
  const dismiss = () => {
    if (!notice) return;
    setDismissed(notice.version);
    setNotice(null);
    void acknowledge(notice.version);
  };
  return (
    <Dialog
      open={open}
      title={notice ? `发现新版 v${notice.version}` : '应用更新'}
      onClose={() => {
        if (open) dismiss();
      }}
    >
      <p>更新已通过来源验证，可以查看更新说明并决定是否更新。</p>
      <div className="settings-update-notes">{notice?.notes}</div>
      <div className="preparation-actions">
        <Button
          variant="primary"
          onClick={() => {
            dismiss();
            window.location.assign('/settings?tab=advanced');
          }}
        >
          查看更新
        </Button>
        <Button onClick={dismiss}>稍后</Button>
      </div>
    </Dialog>
  );
}

export function UpdateNotification() {
  return window.__TAURI_INTERNALS__ ? <DesktopUpdateNotification /> : null;
}
