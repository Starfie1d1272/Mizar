import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocalChannelClient } from '../realtime';
import { Button, StatusPill } from '../ui';
import { useLocalRead, openTool, command } from '../preparation/client';
import {
  observerFailureReason,
  observerNeedsRecovery,
  resumeObserverReceiver,
  type ObserverRuntimeView,
  type ConnectionPreparationView,
} from '../preparation/observer-preparation';
import { observerHotkeyLabel } from '@mizar/hud-view';

export function ObserverHints() {
  const runtime = useLocalRead<ObserverRuntimeView>('/local/v1/observer');
  const configuration = useLocalRead<ConnectionPreparationView & { calibrationRevision: string }>(
    '/local/v1/observer-assist',
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [recalibrating, setRecalibrating] = useState(false);
  const scope = JSON.stringify([configuration?.revision, configuration?.mapConnection?.id]);
  const [calibrationError, setCalibrationError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const client = useLocalChannelClient('assist');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const observer = state.state === 'live' ? state.current?.payload.observer : undefined;
  const awaitingTooLong = Boolean(
    configuration?.settings.enabled &&
    configuration.mapConnection &&
    configuration?.connectionRequestedAt &&
    !configuration.receiverPaused &&
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
  if (!enabled || !configuration?.connection || !configuration.mapConnection) return null;
  if (runtime && !runtime.active && !pending && !paused && !needsRecovery && !error) return null;
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
          {window.__TAURI_INTERNALS__ ? (
            <Button
              disabled={retrying || !runtime?.retryAvailable}
              aria-busy={retrying}
              onClick={() => {
                if (retrying || runtime?.pending || !runtime?.retryAvailable) return;
                setRetrying(true);
                setError('');
                void resumeObserverReceiver(configuration)
                  .then((result) => setError(result?.warning ?? ''))
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error ? reason.message : '提前提示重试未完成，请重试。',
                    ),
                  )
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? '正在重试…' : '重新连接'}
            </Button>
          ) : null}
        </>
      ) : reconnecting || connecting || !observer || observer.state !== 'ready' ? (
        <StatusPill tone="info">
          {reconnecting
            ? '正在重连提前提示'
            : connecting
              ? '正在连接提前提示'
              : observer?.state === 'paused'
                ? '比赛暂停'
                : '正在接收比赛数据…'}
        </StatusPill>
      ) : null}
      {runtime?.active && !paused && !pending && !needsRecovery && !reconnecting && !connecting ? (
        <div>
          <Button
            disabled={
              recalibrating ||
              retrying ||
              !configuration.calibrationRevision ||
              configuration.waitingForMap ||
              state.state !== 'live'
            }
            aria-busy={recalibrating}
            title="提示与画面时间不符时重新校准；期间暂时停止提示，不会重连游戏。"
            onClick={() => {
              if (recalibrating || !configuration.mapConnection) return;
              setRecalibrating(true);
              setError('');
              setCalibrationError(null);
              const requestScope = scope;
              const mapConnectionId = configuration.mapConnection.id;
              void (async () => {
                const response = await fetch('/local/v1/observer-assist', {
                  cache: 'no-store',
                  signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) throw new Error('无法读取当前校准状态，请重试。');
                const current = (await response.json()) as typeof configuration;
                if (
                  current?.revision !== configuration.revision ||
                  current?.mapConnection?.id !== mapConnectionId ||
                  typeof current?.calibrationRevision !== 'string'
                )
                  throw new Error('本图连接已变化，请刷新后重新校准。');
                await command('/operator/observer-assist', {
                  action: 'recalibrate',
                  calibrationRevision: current.calibrationRevision,
                  id: mapConnectionId,
                  expectedRevision: configuration.revision,
                });
              })()
                .catch((reason: unknown) => {
                  setCalibrationError({
                    scope: requestScope,
                    message: reason instanceof Error ? reason.message : '重新校准未完成，请重试。',
                  });
                })
                .finally(() => setRecalibrating(false));
            }}
          >
            {recalibrating ? '正在重新校准…' : '重新校准提前提示'}
          </Button>
        </div>
      ) : null}
      {calibrationError?.scope === scope ? <p role="alert">{calibrationError.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {hints.length && !paused && !pending && !needsRecovery && !reconnecting && !connecting ? (
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
