import { useState } from 'react';
import type { ObsOutputCommand, ObsOutputKind, ObsOutputStatus } from '@mizar/protocol/obs';
import { Button, Dialog, StatusBanner } from '../ui';
import { ObsOutputCommandError, useObsOutputs } from './obs-client';

function label(
  kind: ObsOutputKind,
  state: ObsOutputStatus | undefined,
  pending?: ObsOutputCommand | null,
) {
  const name = kind === 'stream' ? '直播' : '录像';
  const action = pending?.output === kind ? pending.action : state?.pending;
  if (kind === 'stream' && (action === 'start' || state?.phase === 'starting'))
    return '正在连接直播…';
  if (action || state?.phase === 'starting' || state?.phase === 'stopping')
    return `${action === 'stop' || state?.phase === 'stopping' ? '停止' : '开始'}${name}中…`;
  if (state?.phase === 'unknown' && state.active === true) return `${name}连接待确认 · 停止`;
  if (!state || state.active === null || state.phase === 'unknown') return `${name}状态未确认`;
  if (state.phase === 'reconnecting') return `${name}重连 · 停止`;
  if (state.phase === 'paused') return `${name}已暂停 · 停止`;
  return `${state.active ? '停止' : '开始'}${name}`;
}

function StreamHealth({ stream }: { stream: ObsOutputStatus }) {
  const health = stream.health;
  const duration = health?.durationMs;
  const seconds = duration == null ? null : Math.floor(duration / 1000);
  const time =
    seconds === null
      ? '—'
      : [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
          .map((value) => String(value).padStart(2, '0'))
          .join(':');
  const connection = stream.phase === 'reconnecting' ? '正在重连' : '已连接';
  return (
    <div className="workspace-stream-health" aria-label="直播状态">
      <span>连接 {connection}</span>
      {seconds === null ? null : <span>时长 {time}</span>}
      <span>码率 {health?.bitrateKbps == null ? '—' : `${health.bitrateKbps} kb/s`}</span>
      <span>推流丢帧 {health?.droppedFrames ?? '—'}</span>
    </div>
  );
}

export function ObsOutputControls({
  onError,
  connected,
  startWarning,
  audioRepair,
}: {
  onError: (message: string) => void;
  connected: boolean;
  startWarning: string | null;
  audioRepair: { run: () => void; busy: boolean } | null;
}) {
  const {
    outputs,
    pending,
    recovering,
    recoveryError,
    execute,
    recoverCapture,
    cancelStreamStart,
  } = useObsOutputs();
  const [confirmation, setConfirmation] = useState<ObsOutputCommand | null>(null);
  const cleanupPending = outputs?.preparation === 'cleanup_pending';
  const preparingStream =
    pending.stream?.action === 'start' && Boolean(outputs?.preparation) && !outputs?.stream.pending;
  const showStartWarning = Boolean(
    startWarning && outputs?.stream.phase === 'idle' && !pending.stream && !outputs.stream.pending,
  );
  const outputsIdle = Boolean(
    outputs &&
    [outputs.stream, outputs.record].every(
      (output) => output.active === false && output.phase === 'idle' && !output.pending,
    ),
  );
  async function run(command: ObsOutputCommand) {
    setConfirmation(null);
    onError('');
    try {
      await execute(command);
    } catch (error) {
      if (!(error instanceof ObsOutputCommandError && error.observed))
        onError(error instanceof Error ? error.message : 'OBS 操作未完成。');
    }
  }
  const awaitingOutput =
    !outputs ||
    [outputs.stream, outputs.record].some(
      (output) => output.active === null || output.phase === 'unknown',
    );
  const confirmedState = confirmation ? outputs?.[confirmation.output] : undefined;
  const canConfirm =
    confirmation &&
    confirmedState?.revision === confirmation.expectedRevision &&
    confirmedState.active === true &&
    !confirmedState.pending &&
    confirmedState.phase !== 'stopping' &&
    !pending[confirmation.output];
  return (
    <>
      {showStartWarning ? (
        <StatusBanner tone="warning">
          {startWarning}
          {audioRepair && outputsIdle ? (
            <Button disabled={audioRepair.busy} onClick={audioRepair.run}>
              {audioRepair.busy ? '正在修复…' : '修复场景与音频'}
            </Button>
          ) : null}
        </StatusBanner>
      ) : null}
      <div className="workspace-obs-controls" aria-label="OBS 输出控制">
        {(['stream', 'record'] as const).map((kind) => {
          const state = outputs?.[kind];
          const commandPending = pending[kind];
          const busy = Boolean(
            commandPending ||
            (recovering && state?.active !== true) ||
            state?.pending ||
            state?.phase === 'starting' ||
            state?.phase === 'stopping',
          );
          const preparation =
            !state?.active &&
            outputs?.preparation &&
            !(kind === 'stream' && cleanupPending && outputsIdle);
          const text =
            kind === 'stream' && preparingStream
              ? '正在检查开播画面…'
              : label(kind, state, commandPending);
          const active = state?.active === true && state.phase === 'active' && !busy;
          const waiting = !state || state.active === null || state.phase === 'unknown';
          const displayed = active ? `${kind === 'stream' ? '直播中' : '录像中'} · 停止` : text;
          return (
            <Button
              key={kind}
              disabled={busy || Boolean(preparation) || !state || state.active === null}
              aria-label={displayed}
              data-waiting={waiting || undefined}
              data-live={active || undefined}
              loading={Boolean(
                commandPending ||
                state?.pending ||
                state?.phase === 'starting' ||
                state?.phase === 'stopping',
              )}
              variant={
                kind === 'stream' && state?.phase === 'idle' && !busy && !preparation
                  ? 'primary'
                  : 'secondary'
              }
              onClick={() => {
                const command: ObsOutputCommand = {
                  output: kind,
                  action: state?.active ? 'stop' : 'start',
                  expectedRevision: state?.active === null || !state ? null : state.revision,
                };
                if (command.action === 'stop') setConfirmation(command);
                else void run(command);
              }}
            >
              {displayed}
            </Button>
          );
        })}
        {connected && awaitingOutput ? <small>等待 OBS 确认输出</small> : null}
      </div>
      {preparingStream ? (
        <StatusBanner tone="info">
          正在检查游戏画面，检查完成后会开始直播。
          <Button onClick={cancelStreamStart}>取消开播</Button>
        </StatusBanner>
      ) : null}
      {outputs?.stream.phase === 'active' || outputs?.stream.phase === 'reconnecting' ? (
        <StreamHealth stream={outputs.stream} />
      ) : null}
      {cleanupPending && !preparingStream ? (
        <StatusBanner tone="warning">
          {recoveryError ||
            (outputsIdle
              ? '游戏画面检查未完成，请重新检查。'
              : '游戏画面检查未完成，请先确认 OBS 直播和录像已停止。')}
          <Button
            disabled={Boolean(pending.stream || pending.record) || recovering || !outputsIdle}
            loading={recovering}
            onClick={() => {
              onError('');
              void recoverCapture();
            }}
          >
            重新检查游戏画面
          </Button>
        </StatusBanner>
      ) : null}
      {(['stream', 'record'] as const).map((kind) => {
        const state = outputs?.[kind];
        return state?.result?.message &&
          ['failed', 'unknown'].includes(state.result.state) &&
          state.phase !== 'active' ? (
          <StatusBanner key={kind} tone="warning">
            {state.result.message ??
              `${kind === 'stream' ? '直播' : '录像'}操作未完成，请在 OBS 核对。`}
          </StatusBanner>
        ) : null;
      })}
      <Dialog
        showCloseButton={false}
        open={confirmation !== null}
        title={
          !canConfirm
            ? 'OBS 状态已变化，请重新核对'
            : confirmation?.output === 'stream'
              ? '停止 OBS 直播？'
              : '停止 OBS 录像？'
        }
        onClose={() => setConfirmation(null)}
        actions={
          <>
            <Button autoFocus onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!canConfirm}
              onClick={() => confirmation && void run(confirmation)}
            >
              确认停止
            </Button>
          </>
        }
      />
    </>
  );
}
