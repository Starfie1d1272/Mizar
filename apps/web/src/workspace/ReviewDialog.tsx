import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog } from '../ui';
import { desktopInvoke } from './client';
import './preflight-review.css';

export const isReviewWindow = () => window.location.pathname === '/workspace/review';
export async function closeReviewWindow() {
  if (isReviewWindow() && window.__TAURI_INTERNALS__) await desktopInvoke('close_review');
}

/** Browser preview and native review use the same content. Native panels open a dedicated focused window. */
export function ReviewDialog({
  kind,
  ...props
}: ComponentProps<typeof Dialog> & {
  kind: 'preflight' | 'roster' | 'sync' | 'issues';
}) {
  const external = Boolean(window.__TAURI_INTERNALS__) && !isReviewWindow();
  const [error, setError] = useState('');
  const opening = useRef(false);
  const close = useRef(props.onClose);
  useEffect(() => {
    close.current = props.onClose;
  }, [props.onClose]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!external || !props.open || opening.current) return;
    opening.current = true;
    void desktopInvoke('open_tool', { tool: 'review', presetId: kind })
      .then(() => {
        close.current();
        setError('');
      })
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : '核对窗口未能打开，请重试。'),
      )
      .finally(() => {
        opening.current = false;
      });
  }, [external, props.open, kind, retry]);
  if (external)
    return error ? (
      <p role="alert">
        {error}
        <Button onClick={() => setRetry((value) => value + 1)}>重新打开核对窗口</Button>
      </p>
    ) : null;
  const selected = new URLSearchParams(window.location.search).get('kind') ?? 'preflight';
  if (isReviewWindow() && selected !== kind) return null;
  return createPortal(
    <Dialog
      {...props}
      modal={!isReviewWindow()}
      className={`workspace-review-dialog ${props.className ?? ''}`}
      onClose={() => {
        props.onClose();
        void closeReviewWindow().catch((failure) => setError(String(failure)));
      }}
    />,
    document.body,
  );
}
