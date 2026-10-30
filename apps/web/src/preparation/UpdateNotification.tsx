import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../ui';
import { useLocalRead } from './client';
import type { UpdateStatus } from './UpdateSettings';
import './updates.css';

type Notification = { version: string; notes: string };
type EntryRequest = {
  updates: UpdateStatus;
  signal: AbortSignal;
  resolve: (proceed: boolean) => void;
  handled: boolean;
};

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
  const [entry, setEntry] = useState<EntryRequest | null>(null);
  const activeEntry = useRef<EntryRequest | null>(null);
  useEffect(() => {
    const onEntry = (event: Event) => {
      const request = (event as CustomEvent<EntryRequest>).detail;
      if (activeEntry.current) return;
      request.handled = true;
      activeEntry.current = request;
      request.signal.addEventListener(
        'abort',
        () => {
          if (activeEntry.current !== request) return;
          activeEntry.current = null;
          setEntry(null);
          request.resolve(false);
        },
        { once: true },
      );
      setEntry(request);
    };
    window.addEventListener('mizar:entry-update', onEntry);
    return () => {
      window.removeEventListener('mizar:entry-update', onEntry);
      activeEntry.current?.resolve(false);
      activeEntry.current = null;
    };
  }, []);
  const finishEntry = (proceed: boolean) => {
    const request = activeEntry.current;
    activeEntry.current = null;
    setEntry(null);
    request?.resolve(proceed);
  };
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedMulnx, setDismissedMulnx] = useState<string | null>(null);
  const [mulnxNotice, setMulnxNotice] = useState<{ identity: string; version: string } | null>(
    null,
  );
  const latest = useRef(status);
  const request = useRef<AbortController | null>(null);
  const acknowledging = useRef(false);
  const acknowledgingMulnx = useRef(false);
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
  const acknowledgeMulnx = useCallback(async (identity: string) => {
    if (acknowledgingMulnx.current) return;
    acknowledgingMulnx.current = true;
    try {
      await fetch('/operator/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss-mulnx-notification', identity }),
        keepalive: true,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* Retry on a subsequent poll. */
    } finally {
      acknowledgingMulnx.current = false;
    }
  }, []);
  useEffect(() => {
    if (
      dismissedMulnx &&
      status?.mulnxNotificationPending &&
      status.mulnx?.notificationIdentity === dismissedMulnx
    )
      void acknowledgeMulnx(dismissedMulnx);
  }, [status, dismissedMulnx, acknowledgeMulnx]);
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
      (!mulnxNotice || mulnxNotice.identity !== tool.notificationIdentity) &&
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
  const shownMizar = entry?.updates.notificationPending ? entry.updates.candidate : notice;
  const shownMulnx =
    entry?.updates.mulnxNotificationPending &&
    entry.updates.mulnx?.latest &&
    entry.updates.mulnx.notificationIdentity
      ? { identity: entry.updates.mulnx.notificationIdentity, version: entry.updates.mulnx.latest }
      : mulnxNotice;
  const mizarOpen = entry
    ? Boolean(entry.updates.notificationPending && shownMizar)
    : shownMizar !== null &&
      shownMizar?.version === status?.candidate?.version &&
      dismissed !== shownMizar?.version;
  const mulnxOpen = entry
    ? Boolean(entry.updates.mulnxNotificationPending && shownMulnx)
    : shownMulnx !== null &&
      status?.mulnxNotificationPending &&
      shownMulnx?.identity === status.mulnx?.notificationIdentity;
  const open = Boolean(
    (mizarOpen || mulnxOpen) &&
    (entry?.updates.notificationSafe ?? status?.notificationSafe) &&
    canInterrupt(),
  );
  const dismissMizar = () => {
    if (!shownMizar || !mizarOpen) return;
    setDismissed(shownMizar.version);
    setNotice(null);
    void acknowledge(shownMizar.version);
  };
  const dismissMulnx = () => {
    if (!shownMulnx || !mulnxOpen) return;
    setDismissedMulnx(shownMulnx.identity);
    setMulnxNotice(null);
    void acknowledgeMulnx(shownMulnx.identity);
  };
  const dismiss = () => {
    dismissMizar();
    dismissMulnx();
    if (entry) finishEntry(true);
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
          <p>Mizar v{shownMizar?.version} 可更新。</p>
          <div className="settings-update-notes">{shownMizar?.notes}</div>
        </>
      ) : null}
      {mulnxOpen ? <p>MulNX {shownMulnx?.version} 可更新，建议开播前更新。</p> : null}
      <div className="preparation-actions">
        {mizarOpen ? (
          <Button
            variant="primary"
            onClick={() => {
              dismissMizar();
              if (entry) finishEntry(false);
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
              dismissMulnx();
              if (entry) finishEntry(false);
              window.location.assign('/packages');
            }}
          >
            查看 MulNX 更新
          </Button>
        ) : null}
        <Button onClick={dismiss}>稍后</Button>
        {entry ? <Button onClick={() => finishEntry(false)}>取消进入</Button> : null}
      </div>
    </Dialog>
  );
}

export function UpdateNotification() {
  return window.__TAURI_INTERNALS__ ? <DesktopUpdateNotification /> : null;
}
