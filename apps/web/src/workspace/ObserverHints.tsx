import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocalChannelClient } from '../realtime';
import { Button, StatusPill } from '../ui';
import { useLocalRead, openTool } from '../preparation/client';
import {
  observerFailureReason,
  observerNeedsRecovery,
  resumeObserverReceiver,
  type ObserverRuntimeView,
  type ConnectionPreparationView,
} from '../preparation/observer-preparation';
import { observerHotkeyLabel } from '@mizar/hud-view';
import { useObserverHintEvidence } from './observer-hint-evidence';

export function ObserverHints() {
  const runtime = useLocalRead<ObserverRuntimeView>('/local/v1/observer');
  const configuration = useLocalRead<ConnectionPreparationView>('/local/v1/observer-assist');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const client = useLocalChannelClient('assist');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const observer = state.state === 'live' ? state.current?.payload.observer : undefined;
  const draining = observer?.waitingReason === 'normal-drain';
  const awaitingProgramMap = observer?.waitingReason === 'waiting-next-map';
  const awaitingTooLong = Boolean(
    configuration?.settings.enabled &&
    configuration.mapConnection &&
    configuration?.connectionRequestedAt &&
    !configuration.receiverPaused &&
    !draining &&
    !awaitingProgramMap &&
    runtime?.active &&
    !runtime.pending &&
    now - configuration.connectionRequestedAt > 60_000 &&
    observer?.state !== 'ready' &&
    observer?.state !== 'paused',
  );
  const [clock, setClock] = useState({ observer, elapsed: 0 });
  useEffect(() => {
    if (!observer?.hints.length) return;
    const receivedAt = performance.now();
    const timer = window.setInterval(() => {
      setClock({ observer, elapsed: (performance.now() - receivedAt) / 1000 });
    }, 100);
    return () => window.clearInterval(timer);
  }, [observer]);
  // Advance the received countdown locally so an event also expires between snapshots.
  const elapsed = clock.observer === observer ? clock.elapsed : 0;
  const hints =
    observer?.hints
      .map((hint) => ({ ...hint, remainingSeconds: hint.remainingSeconds - elapsed }))
      .filter((hint) => hint.remainingSeconds > 0)
      .sort((a, b) => b.remainingSeconds - a.remainingSeconds) ?? [];
  const enabled = Boolean(configuration?.settings.enabled);
  const paused = Boolean(configuration?.receiverPaused);
  const needsRecovery = enabled && !paused && Boolean(runtime && observerNeedsRecovery(runtime));
  const pending = enabled && runtime?.pending;
  const reconnecting = enabled && runtime?.health?.state === 'reconnecting';
  const connecting = enabled && runtime?.health?.state === 'connecting';
  const waitingNextMap = awaitingProgramMap || runtime?.terminal?.reason === 'source-hltv-stop';
  const sourceStale = observer?.waitingReason === 'source-stale';
  const reconnectButton = (label: string, retryingLabel: string) =>
    window.__TAURI_INTERNALS__ ? (
      <Button
        disabled={retrying || !runtime?.retryAvailable}
        aria-busy={retrying}
        onClick={() => {
          if (retrying || runtime?.pending || !runtime?.retryAvailable) return;
          setRetrying(true);
          setError('');
          void resumeObserverReceiver(configuration!)
            .then((result) => setError(result?.warning ?? ''))
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : '提前提示重试未完成，请重试。'),
            )
            .finally(() => setRetrying(false));
        }}
      >
        {retrying ? retryingLabel : label}
      </Button>
    ) : null;
  const showPanel =
    enabled &&
    configuration?.connection &&
    configuration.mapConnection &&
    (!runtime ||
      runtime.active ||
      pending ||
      paused ||
      needsRecovery ||
      error ||
      draining ||
      waitingNextMap);
  const visibleHints =
    showPanel &&
    !paused &&
    (draining || (!pending && !needsRecovery && !reconnecting && !connecting))
      ? hints
      : [];
  const cursor = state.state === 'live' ? state.current?.cursor : undefined;
  useObserverHintEvidence(
    cursor
      ? JSON.stringify([cursor.producerInstanceId, cursor.liveSessionId, cursor.mapEpoch])
      : '',
    visibleHints.map(({ id }) => id).join(','),
    paused
      ? 'receiver_paused'
      : observer && hints.length < observer.hints.length
        ? 'local_countdown_elapsed'
        : (observer?.waitingReason ?? 'presentation_ended'),
  );
  if (!showPanel) return null;
  return (
    <section className="workspace-observer-assist" aria-label="私有提前提示">
      {awaitingTooLong && !needsRecovery && !reconnecting ? (
        <p role="status">
          仍未收到可用于提前提示的有效数据，请复查本图连接与游戏状态。
          <Button
            onClick={() => {
              void openTool('connection').catch((reason: unknown) => setError(String(reason)));
            }}
          >
            复查 GoTV
          </Button>
        </p>
      ) : null}
      {paused ? (
        <>
          <StatusPill tone="info">提前提示接收已暂停</StatusPill>
          {window.__TAURI_INTERNALS__ ? (
            <Button
              disabled={retrying || !runtime?.retryAvailable}
              onClick={() => {
                if (retrying || !runtime?.retryAvailable) return;
                setRetrying(true);
                setError('');
                void resumeObserverReceiver(configuration)
                  .then((result) => setError(result?.warning ?? ''))
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : '提示接收未完成，请重试。'),
                  )
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? '正在恢复…' : '恢复提前提示接收'}
            </Button>
          ) : null}
        </>
      ) : draining ? (
        <StatusPill tone="info">继续显示本图提前提示</StatusPill>
      ) : pending ? (
        <StatusPill tone="info">
          {runtime?.recovering ? '正在恢复提前提示' : '正在准备提前提示'}
        </StatusPill>
      ) : needsRecovery ? (
        <>
          <StatusPill
            tone={
              runtime?.error || runtime?.failed || runtime?.health.state === 'failed'
                ? 'danger'
                : 'warning'
            }
          >
            {runtime?.stopReason === 'lease-expired' || runtime?.stopReason === 'host-invalid'
              ? '提前提示已中断'
              : runtime?.failed || runtime?.health.state === 'failed'
                ? '提前提示连接失败'
                : runtime?.error
                  ? '提前提示准备失败'
                  : runtime?.health.state === 'ended'
                    ? '提前提示连接已结束'
                    : '提前提示接收已停止'}
          </StatusPill>
          <p>
            {runtime?.error && !runtime.failed
              ? '辅助操作未完成，请核对本场连接后重试。'
              : observerFailureReason(runtime!)}
          </p>
          {reconnectButton('重新连接', '正在重试…')}
        </>
      ) : waitingNextMap ? (
        <StatusPill tone="info">
          {awaitingProgramMap && runtime?.health?.state === 'live'
            ? '已接收下一图数据，等待节目切图'
            : '等待下一图的 GoTV 连接'}
        </StatusPill>
      ) : sourceStale ? (
        <>
          <StatusPill tone="warning">GoTV 数据中断，暂未收到新数据</StatusPill>
          {reconnectButton('重新连接', '正在重试…')}
        </>
      ) : reconnecting || connecting || !observer || observer.state !== 'ready' ? (
        <StatusPill tone="info">
          {reconnecting
            ? '正在重连提前提示'
            : connecting
              ? '正在连接提前提示'
              : observer?.state === 'paused'
                ? '比赛暂停'
                : ((
                    {
                      'source-disconnected': 'GoTV 观察连接已断开',
                      'program-stale': '正在等待节目端比赛数据…',
                      'source-map-mismatch': 'GoTV 与当前节目地图不一致',
                    } as Record<string, string>
                  )[observer?.waitingReason ?? ''] ?? '正在接收比赛数据…')}
        </StatusPill>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {visibleHints.length ? (
        <ol className="observer-hints">
          {visibleHints.map((hint) => (
            <li key={hint.id}>
              <span className="observer-hints__time">{Math.ceil(hint.remainingSeconds)} 秒后</span>
              <span className="observer-hints__players">
                <kbd>{observerHotkeyLabel(hint.attacker.observerSlot)}</kbd>{' '}
                <strong title={hint.attacker.name}>{hint.attacker.name}</strong>
                <small>击杀</small>
                <kbd>{observerHotkeyLabel(hint.victim.observerSlot)}</kbd>{' '}
                <span title={hint.victim.name}>{hint.victim.name}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
