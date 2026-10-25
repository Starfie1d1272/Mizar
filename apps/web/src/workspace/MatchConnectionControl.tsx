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
        ? '节目命令已提交'
        : runtime?.active
          ? '早源已启动'
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
              setError(reason instanceof Error ? reason.message : '本图连接未读取，请重试。'),
            )
            .finally(() => {
              lock.current = false;
              setBusy(false);
            });
        }}
      >
        本图连接 · {status}
      </Button>
      {runtime?.programCommandQueued || runtime?.active ? (
        <small role="status">
          节目：{runtime.programCommandQueued ? '命令已提交，实际连接请在游戏内核对' : '请手动连接'}
          ； 早源：
          {!view?.settings.enabled
            ? '辅助关闭'
            : runtime.health?.state === 'live'
              ? '接收中'
              : '等待接收'}
          。 时间对齐与提示见雷达下方。
        </small>
      ) : null}
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
    </>
  );
}
