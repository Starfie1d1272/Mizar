import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { openTool } from '../preparation/client';

/** Opening the single connection tool never submits or reconnects the game. */
export function MatchConnectionControl({ primary = false }: { primary?: boolean }) {
  const [error, setError] = useState('');
  return (
    <>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        onClick={() => {
          setError('');
          void openTool('connection').catch((reason: unknown) =>
            setError(reason instanceof Error ? reason.message : '连接窗口未能打开，请重试。'),
          );
        }}
      >
        填写 GoTV，开启提前提示
      </Button>
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
    </>
  );
}
