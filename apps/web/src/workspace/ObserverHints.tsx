import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocalChannelClient } from '../realtime';
import { Button, StatusPill } from '../ui';
import { useLocalRead } from '../preparation/client';
import { desktopInvoke } from './client';
import {
  observerFailureReason,
  type ObserverRuntimeView,
  type ConnectionPreparationView,
} from '../preparation/observer-preparation';
import { observerHotkeyLabel } from '../program/observer-hotkey';

export function ObserverHints() {
  const runtime = useLocalRead<ObserverRuntimeView>('/local/v1/observer');
  const configuration = useLocalRead<ConnectionPreparationView>('/local/v1/observer-assist');
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const client = useLocalChannelClient('assist');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const observer = state.state === 'live' ? state.current?.payload.observer : undefined;
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
  const needsRecovery =
    enabled &&
    Boolean(
      runtime?.error ||
      runtime?.failed ||
      ['failed', 'ended', 'stopped'].includes(runtime?.health?.state ?? ''),
    );
  const pending = enabled && runtime?.pending;
  const reconnecting = enabled && runtime?.health?.state === 'reconnecting';
  const connecting = enabled && runtime?.health?.state === 'connecting';
  if (!observer && !enabled) return null;
  const labels = {
    connecting: '连接早源',
    paused: '比赛暂停',
    unavailable:
      observer?.waitingReason === 'calibration-reacquiring'
        ? '正在重新校准延迟'
        : observer?.waitingReason === 'source-stale'
          ? '等待早源数据'
          : observer?.waitingReason === 'identity-unavailable'
            ? '等待当前选手身份'
            : observer?.waitingReason === 'source-map-mismatch'
              ? '等待早源切换当前地图'
              : observer?.waitingReason === 'map-missing'
                ? '等待当前地图'
                : '等待节目数据',
  };
  return (
    <section className="workspace-observer-assist" aria-label="私有观察辅助">
      {pending ? (
        <StatusPill tone="info">正在准备早源</StatusPill>
      ) : needsRecovery ? (
        <>
          <StatusPill
            tone={
              runtime?.error || runtime?.failed || runtime?.health.state === 'failed'
                ? 'danger'
                : 'warning'
            }
          >
            {runtime?.failed || runtime?.health.state === 'failed'
              ? '早源连接失败'
              : runtime?.error
                ? '观察辅助准备失败'
                : runtime?.health.state === 'ended'
                  ? '早源连接已结束'
                  : '早源接收已停止'}
          </StatusPill>
          <p>
            {runtime?.error && !runtime.failed
              ? '辅助操作未完成，请核对本场连接后重试。'
              : observerFailureReason(runtime!)}
          </p>
          {window.__TAURI_INTERNALS__ ? (
            <Button
              disabled={retrying || !runtime?.retryAvailable}
              aria-busy={retrying}
              onClick={() => {
                if (retrying || runtime?.pending || !runtime?.retryAvailable) return;
                setRetrying(true);
                setError('');
                void desktopInvoke('observer_command', { action: 'start-configured' })
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : '早源重试未完成，请重试。'),
                  )
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? '正在重试…' : '重新连接早源'}
            </Button>
          ) : null}
        </>
      ) : reconnecting || connecting || !observer || observer.state !== 'ready' ? (
        <StatusPill tone="info">
          {reconnecting
            ? '正在重连早源'
            : connecting
              ? '正在连接早源'
              : observer
                ? labels[observer.state as keyof typeof labels]
                : '辅助状态待确认'}
        </StatusPill>
      ) : null}
      {observer?.state === 'ready' && !pending && !needsRecovery && !reconnecting && !connecting ? (
        <>
          <StatusPill tone="info">
            延迟 {(observer.effectiveDelaySeconds ?? observer.expectedDelaySeconds).toFixed(1)} 秒 ·
            {observer.calibrationState === 'measured'
              ? '实时校准'
              : observer.calibrationState === 'held'
                ? '保持上次校准'
                : '尚未校准'}
          </StatusPill>
          {hints.length === 0 ? (
            <p>
              {observer.waitingReason === 'buffering' && observer.nextWindowSeconds !== null
                ? `正在积累预告，约 ${Math.ceil(observer.nextWindowSeconds)} 秒后进入提示窗口`
                : '等待早源事件'}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {hints.length && !pending && !needsRecovery && !reconnecting && !connecting ? (
        <ol className="observer-hints">
          {hints.map((hint) => (
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
