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
    !document.querySelector('dialog[open]:not(.updates-notification)') &&
    !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')
  );
}

function DesktopUpdateNotification() {
  const status = useLocalRead<UpdateStatus>('/local/v1/updates', 3000);
  const [notice, setNotice] = useState<Notification | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedMulnx, setDismissedMulnx] = useState<string | null>(null);
  const [mulnxNotice, setMulnxNotice] = useState<{ identity: string; version: string } | null>(
    null,
  );
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
  useEffect(() => {
    const tool = status?.mulnx;
    if (
      status?.mulnxNotificationPending &&
      status.notificationSafe &&
      tool?.notificationIdentity &&
      tool.latest &&
      !mulnxNotice &&
      dismissedMulnx !== tool.notificationIdentity &&
      canInterrupt()
    ) {
      const identity = tool.notificationIdentity;
      const version = tool.latest;
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled && canInterrupt()) setMulnxNotice({ identity, version });
      });
      return () => {
        cancelled = true;
      };
    }
  }, [status, mulnxNotice, dismissedMulnx, notice]);
  const mizarOpen =
    notice !== null &&
    notice.version === status?.candidate?.version &&
    dismissed !== notice.version;
  const mulnxOpen =
    mulnxNotice !== null &&
    status?.mulnxNotificationPending &&
    mulnxNotice.identity === status.mulnx?.notificationIdentity;
  const open = Boolean(
    (mizarOpen || mulnxOpen) &&
    status?.notificationSafe &&
    document.hasFocus() &&
    document.visibilityState === 'visible',
  );
  const dismiss = () => {
    if (notice && mizarOpen) {
      setDismissed(notice.version);
      setNotice(null);
      void acknowledge(notice.version);
    }
    if (mulnxNotice && mulnxOpen) {
      setDismissedMulnx(mulnxNotice.identity);
      setMulnxNotice(null);
      void fetch('/operator/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dismiss-mulnx-notification',
          identity: mulnxNotice.identity,
        }),
        keepalive: true,
        signal: AbortSignal.timeout(8000),
      }).catch(() => undefined);
    }
  };
  return (
    <Dialog
      open={open}
      title="发现新版"
      className="updates-notification"
      onClose={() => {
        if (open) dismiss();
      }}
    >
      {mizarOpen ? (
        <>
          <p>Mizar v{notice?.version} 可更新。</p>
          <div className="settings-update-notes">{notice?.notes}</div>
        </>
      ) : null}
      {mulnxOpen ? <p>MulNX {mulnxNotice?.version} 可更新，建议开播前更新。</p> : null}
      <div className="preparation-actions">
        {mizarOpen ? (
          <Button
            variant="primary"
            onClick={() => {
              dismiss();
              window.location.assign('/settings?tab=advanced');
            }}
          >
            查看 Mizar 更新
          </Button>
        ) : null}
        {mulnxOpen ? (
          <Button
            variant="primary"
            onClick={() => {
              dismiss();
              window.location.assign('/resources');
            }}
          >
            查看 MulNX 更新
          </Button>
        ) : null}
        <Button onClick={dismiss}>稍后</Button>
      </div>
    </Dialog>
  );
}

export function UpdateNotification() {
  return window.__TAURI_INTERNALS__ ? <DesktopUpdateNotification /> : null;
}
