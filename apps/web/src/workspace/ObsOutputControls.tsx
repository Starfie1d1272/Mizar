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
  if (state.phase === 'reconnecting') return '重连 · 停止';
  if (state.phase === 'paused') return '暂停 · 停止';
  return `${state.active ? '停止' : '开始'}${name}`;
}

export function ObsOutputControls({ onError }: { onError: (message: string) => void }) {
  const { outputs, pending, recovering, recoveryError, execute, recoverCapture } = useObsOutputs();
  const [confirmation, setConfirmation] = useState<ObsOutputCommand | null>(null);
  const cleanupPending = outputs?.preparation === 'cleanup_pending';
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
  const confirmedState = confirmation ? outputs?.[confirmation.output] : undefined;
  const canConfirm =
    confirmation &&
    confirmedState?.revision === confirmation.expectedRevision &&
    confirmedState.active === true &&
    !confirmedState.pending &&
    confirmedState.phase !== 'stopping' &&
    !pending &&
    !recovering;
  return (
    <>
      <div className="workspace-obs-controls" aria-label="OBS 输出控制">
        {(['stream', 'record'] as const).map((kind) => {
          const state = outputs?.[kind];
          const busy = Boolean(
            pending ||
            recovering ||
            state?.pending ||
            state?.phase === 'starting' ||
            state?.phase === 'stopping',
          );
          const preparation = !state?.active && outputs?.preparation;
          const text = label(kind, state, pending);
          return (
            <Button
              key={kind}
              disabled={busy || Boolean(preparation) || !state || state.active === null}
              aria-label={text}
              loading={Boolean(
                (pending?.output === kind && pending) ||
                state?.pending ||
                state?.phase === 'starting' ||
                state?.phase === 'stopping',
              )}
              variant={state?.active ? 'secondary' : 'primary'}
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
              {state?.active && state.phase === 'active' && !busy
                ? `${kind === 'stream' ? '直播中' : '录像中'} · 停止`
                : text}
            </Button>
          );
        })}
      </div>
      {cleanupPending ? (
        <StatusBanner tone="warning">
          {recoveryError ||
            (outputsIdle
              ? '游戏画面检查未完成，请重新检查。'
              : '游戏画面检查未完成，请先确认 OBS 直播和录像已停止。')}
          <Button
            disabled={Boolean(pending) || recovering || !outputsIdle}
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
