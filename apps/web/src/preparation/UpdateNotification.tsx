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
  const [dismissedLastResult, setDismissedLastResult] = useState(false);
  const [mulnxNotice, setMulnxNotice] = useState<{ identity: string; version: string } | null>(
    null,
  );
  const latest = useRef(status);
  const request = useRef<AbortController | null>(null);
  const acknowledging = useRef(false);
  const acknowledgingMulnx = useRef(false);
  const acknowledgingLastResult = useRef(false);
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
  const acknowledgeLastResult = useCallback(async () => {
    if (acknowledgingLastResult.current) return;
    acknowledgingLastResult.current = true;
    try {
      await fetch('/operator/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss-last-result' }),
        keepalive: true,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* Retry on a subsequent poll. */
    } finally {
      acknowledgingLastResult.current = false;
    }
  }, []);
  useEffect(() => {
    if (dismissedLastResult && status?.lastResultNotificationPending) void acknowledgeLastResult();
  }, [status, dismissedLastResult, acknowledgeLastResult]);
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
  const lastResultKind =
    status?.lastResult === 'restored' || status?.lastResult === 'failed' ? status.lastResult : null;
  const lastResultOpen = Boolean(
    lastResultKind &&
    status?.lastResultNotificationPending &&
    status.lastResultSafe &&
    !dismissedLastResult &&
    canInterrupt(),
  );
  const shownMizar = notice;
  const shownMulnx = mulnxNotice;
  const mizarOpen =
    !lastResultOpen &&
    shownMizar !== null &&
    shownMizar.version === status?.candidate?.version &&
    dismissed !== shownMizar.version;
  const mulnxOpen =
    !lastResultOpen &&
    shownMulnx !== null &&
    status?.mulnxNotificationPending &&
    shownMulnx.identity === status.mulnx?.notificationIdentity;
  const open = Boolean(
    lastResultOpen || ((mizarOpen || mulnxOpen) && status?.notificationSafe && canInterrupt()),
  );
  const dismissLastResult = () => {
    if (!lastResultOpen) return;
    setDismissedLastResult(true);
    void acknowledgeLastResult();
  };
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
    if (lastResultOpen) {
      dismissLastResult();
      return;
    }
    dismissMizar();
    dismissMulnx();
  };
  const dialogTitle = lastResultOpen
    ? lastResultKind === 'restored'
      ? '更新未完成，已恢复旧版'
      : '更新未完成'
    : '发现新版';
  const versionPart = status?.lastResultVersion ? ` v${status.lastResultVersion} ` : '';
  return (
    <Dialog
      open={open}
      title={dialogTitle}
      className="updates-notification"
      onClose={() => {
        if (open) dismiss();
      }}
      showCloseButton={false}
      actions={
        lastResultOpen ? (
          <>
            <Button
              variant="primary"
              onClick={() => {
                dismissLastResult();
                window.location.assign('/settings?tab=advanced');
              }}
            >
              查看更新设置
            </Button>
            <Button onClick={dismissLastResult}>知道了</Button>
          </>
        ) : (
          <>
            {mizarOpen ? (
              <Button
                variant="primary"
                onClick={() => {
                  dismissMizar();
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
                  window.location.assign('/packages');
                }}
              >
                查看 MulNX 更新
              </Button>
            ) : null}
            <Button onClick={dismiss}>稍后</Button>
          </>
        )
      }
    >
      {lastResultOpen ? (
        lastResultKind === 'restored' ? (
          <p>新版{versionPart}未能正常启动，已自动回退到当前版本。你的配置与比赛资料未受影响。</p>
        ) : (
          <>
            <p>应用更新未完成，当前仍运行旧版。原程序与配置未受影响。</p>
            {status?.lastResultMessage ? <p>{status.lastResultMessage}</p> : null}
          </>
        )
      ) : null}
      {mizarOpen ? (
        <>
          <p>Mizar v{shownMizar?.version} 可更新。</p>
          <div className="settings-update-notes">{shownMizar?.notes}</div>
        </>
      ) : null}
      {mulnxOpen ? <p>MulNX {shownMulnx?.version} 可更新，建议开播前更新。</p> : null}
    </Dialog>
  );
}

export function UpdateNotification() {
  return window.__TAURI_INTERNALS__ ? <DesktopUpdateNotification /> : null;
}
