import { useRef, useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { useLocalRead } from '../preparation/client';
import {
  flushObserverPreparation,
  type ConnectionPreparationView,
  type ObserverRuntimeView,
} from '../preparation/observer-preparation';

/** The existing observer owner supplies status; opening a window never starts a connection. */
export function MatchConnectionControl() {
  const view = useLocalRead<ConnectionPreparationView>('/local/v1/observer-assist');
  const runtime = useLocalRead<ObserverRuntimeView & { programCommandQueued?: boolean }>(
    '/local/v1/observer',
  );
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = runtime?.pending
    ? '连接中'
    : runtime?.error || runtime?.failed
      ? '连接失败，可重试'
      : runtime?.programCommandQueued
        ? '节目连接命令已提交，游戏内待核对'
        : runtime?.active
          ? '早源已启动，节目源请在游戏内核对'
          : view?.connection
            ? '待连接'
            : '未连接';
  return (
    <>
      <Button
        disabled={busy || runtime?.pending}
        onClick={() => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError('');
          void flushObserverPreparation(false, true)
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : '本场连接未读取，请重试。'),
            )
            .finally(() => {
              lock.current = false;
              setBusy(false);
            });
        }}
      >
        本场连接 · {status}
      </Button>
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
    </>
  );
}
