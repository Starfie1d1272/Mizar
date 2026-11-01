import { DIAGNOSTIC_CONSENT_REVISION } from '@mizar/protocol/version';
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Checkbox, StatusBanner } from '../ui';
import { command, useLocalRead } from '../preparation/client';
import { DiagnosticConsentDisclosure } from './DiagnosticDeliverySettings';

// Invitation choice is not upload consent. Companion remains the sole owner of
// consent and receives no mutation until the user explicitly confirms.
const noticeKey = 'mizar.diagnostic-delivery.invitation-dismissed';
function dismissedBefore() {
  try {
    return window.localStorage.getItem(noticeKey) === '1';
  } catch {
    return true;
  }
}

export function DiagnosticDeliveryNotice() {
  const [dismissed, setDismissed] = useState(dismissedBefore);
  const [enabled, setEnabled] = useState(true);
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const attempted = useRef(false);
  const [dialogGeneration, setDialogGeneration] = useState(0);
  const [error, setError] = useState('');
  const status = useLocalRead<{ available: boolean; configured: boolean; consent: boolean }>(
    dismissed ? null : '/local/v1/diagnostics/delivery',
    5000,
  );
  const eligible = !dismissed && status?.available && status.configured && !status.consent;
  useEffect(() => {
    if (!eligible || shown) return;
    const offer = () => {
      if (
        document.hasFocus() &&
        document.visibilityState === 'visible' &&
        !document.querySelector('dialog[open]') &&
        !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')
      )
        setShown(true);
    };
    offer();
    const timer = window.setInterval(offer, 1000);
    return () => window.clearInterval(timer);
  }, [eligible, shown]);
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(noticeKey, '1');
    } catch {
      // Keep this page dismissed even if preference storage becomes unavailable.
    }
  };
  async function confirm(choice = enabled) {
    if (pendingRef.current) return;
    if (!choice && !attempted.current) {
      dismiss();
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError('');
    attempted.current = true;
    try {
      await command('/operator/diagnostics/consent', {
        enabled: choice,
        revision: DIAGNOSTIC_CONSENT_REVISION,
      });
      dismiss();
    } catch {
      setError('设置未能确认保存，请重试；取消勾选后确认可保存为关闭。');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  if (!eligible) return null;
  return (
    <Dialog
      key={dialogGeneration}
      open={shown}
      title="自动发送诊断"
      onClose={() => {
        if (!attempted.current) dismiss();
        else {
          // A failed enable response may have reached Companion. Persist withdrawal
          // rather than treating dismissal as evidence that sending stayed off.
          setDialogGeneration((value) => value + 1);
          setEnabled(false);
          void confirm(false);
        }
      }}
      canClose={() => !pendingRef.current}
      actions={
        <>
          <Button variant="primary" disabled={pending} onClick={() => void confirm()}>
            {pending ? '正在保存…' : '确认并继续'}
          </Button>
        </>
      }
    >
      <p>
        帮助维护者定位使用中的问题。确认后，将操作、错误、运行状态和相关配置发送至维护者管理的
        Cloudflare 服务。
        可能包含机器、路径、赛事和选手标识，并非匿名数据；凭据会脱敏，不发送音视频或私人聊天。
      </p>
      <p>诊断正文最多保留七天，会话检索索引保留九十天。可随时在高级设置中暂停或关闭并请求删除。</p>
      <details>
        <summary>完整发送说明与保留规则</summary>
        <DiagnosticConsentDisclosure />
      </details>
      <Checkbox
        label="发送技术诊断"
        checked={enabled}
        disabled={pending}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      <p>{enabled ? '点击确认后开启自动发送。' : '保持关闭，正常使用 Mizar。'}</p>

      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </Dialog>
  );
}
