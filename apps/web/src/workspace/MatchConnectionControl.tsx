import { useEffect, useRef, useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { useLocalRead } from '../preparation/client';
import { desktopInvoke } from './client';
import {
  flushObserverPreparation,
  type ConnectionPreparationView,
  type ObserverRuntimeView,
} from '../preparation/observer-preparation';

/** The existing observer owner supplies status; opening a window never starts a connection. */
export function MatchConnectionControl({ nextMapKey }: { nextMapKey: string | null }) {
  const view = useLocalRead<ConnectionPreparationView>('/local/v1/observer-assist');
  const runtime = useLocalRead<ObserverRuntimeView & { programCommandQueued?: boolean }>(
    '/local/v1/observer',
  );
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = view?.waitingForMap
    ? '等待本图数据'
    : runtime?.programCommandQueued
      ? '连接命令已提交'
      : view?.mapConnection?.mode === 'seamless'
        ? '保持现有连接'
        : view?.connection
          ? '待连接'
          : '未连接';
  const nextMapNeeded = Boolean(nextMapKey && !view?.waitingForMap);
  const open = (next: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    void (
      window.__TAURI_INTERNALS__
        ? desktopInvoke('open_tool', {
            tool: 'review',
            presetId: next ? 'next-connection' : 'connection',
          })
        : flushObserverPreparation(false, true, next)
    )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '本图连接未读取，请重试。'),
      )
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  };
  const prompted = useRef<string | null>(null);
  useEffect(() => {
    if (
      !nextMapNeeded ||
      !nextMapKey ||
      !view ||
      busy ||
      runtime?.pending ||
      prompted.current === nextMapKey
    )
      return;
    prompted.current = nextMapKey;
    open(true);
  }, [nextMapKey, nextMapNeeded, view, busy, runtime?.pending]);
  return (
    <>
      <Button disabled={busy || runtime?.pending} onClick={() => open(nextMapNeeded)}>
        {nextMapNeeded ? '填写下一图 GoTV' : `本图连接 · ${status}`}
      </Button>
      {runtime?.programCommandQueued || runtime?.active ? (
        <small role="status">
          节目：{runtime.programCommandQueued ? '命令已提交，实际连接请在游戏内核对' : '请手动连接'}
          ； 观察辅助：
          {!view?.settings.enabled
            ? '已关闭'
            : runtime.failed || runtime.error
              ? '连接失败，请在观察辅助中重试'
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
