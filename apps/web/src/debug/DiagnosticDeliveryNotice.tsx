import { useState } from 'react';
import { Button, Panel } from '../ui';
import { useLocalRead } from '../preparation/client';
import { DiagnosticDeliverySettings } from './DiagnosticDeliverySettings';

// This is only an invitation preference. It never substitutes for Companion's
// persisted consent, and does not change when the consent text revision changes.
const noticeKey = 'mizar.diagnostic-delivery.invitation-dismissed';
function dismissedBefore() {
  try {
    return window.localStorage.getItem(noticeKey) === '1';
  } catch {
    // Do not repeatedly prompt when this browser cannot persist a dismissal.
    return true;
  }
}

export function DiagnosticDeliveryNotice() {
  const [dismissed, setDismissed] = useState(dismissedBefore);
  const [expanded, setExpanded] = useState(false);
  const status = useLocalRead<{ available: boolean; configured: boolean; consent: boolean }>(
    dismissed ? null : '/local/v1/diagnostics/delivery',
    5000,
  );
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(noticeKey, '1');
    } catch {
      // This invitation remains dismissed for the current mounted page.
      // Consent itself is still exclusively saved by Companion.
    }
  };
  if (dismissed || !status?.available || !status.configured || status.consent) return null;
  return (
    <Panel aria-label="自动发送诊断邀请">
      <strong>帮助定位使用中的问题</strong>
      <p>
        可自愿开启自动发送诊断，将操作、错误与运行状态发送给维护者。
        可能包含路径、赛事和选手标识，并非匿名数据。不开启也能正常使用 Mizar。
      </p>
      <div className="preparation-actions">
        {!expanded ? <Button onClick={() => setExpanded(true)}>了解并开启</Button> : null}
        <Button onClick={dismiss}>暂不开启</Button>
      </div>
      {expanded ? (
        <DiagnosticDeliverySettings
          showProblemReport={false}
          consentInitiallyOpen
          onEnabled={dismiss}
        />
      ) : null}
    </Panel>
  );
}
