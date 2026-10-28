import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { command, useLocalRead, type Production } from '../preparation/client';

/** Browser development remains separate from the native managed launch flow. */
export function MulnxHandoff() {
  const production = useLocalRead<Production>('/local/v1/production', 1000);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (window.__TAURI_INTERNALS__) return null;
  return (
    <details>
      <summary>浏览器联调</summary>
      <p>独立于 Host 借用会话；仅可在准备阶段选择。之后重新连接并确认隔离包。</p>
      <Button
        disabled={busy || production?.mode !== 'preparation'}
        onClick={() => {
          setBusy(true);
          setError('');
          void command('/operator/orchestration', {
            action: 'browser',
            expectedRevision: production?.revision,
          })
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : '联调模式未确认'),
            )
            .finally(() => setBusy(false));
        }}
      >
        使用浏览器联调模式
      </Button>
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </details>
  );
}
