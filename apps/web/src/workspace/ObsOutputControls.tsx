import { useState } from 'react';
import type { ObsOutputCommand, ObsOutputKind, ObsOutputStatus } from '@mizar/protocol/obs';
import { Button, Dialog } from '../ui';
import { useObsOutputs } from './obs-client';

function label(
  kind: ObsOutputKind,
  state: ObsOutputStatus | undefined,
  pending?: ObsOutputCommand | null,
) {
  const name = kind === 'stream' ? '直播' : '录像';
  const action = pending?.output === kind ? pending.action : state?.pending;
  if (action || state?.phase === 'starting' || state?.phase === 'stopping')
    return `${action === 'stop' || state?.phase === 'stopping' ? '停止' : '开始'}${name}中…`;
  if (!state || state.active === null) return `${name}待确认`;
  if (state.phase === 'reconnecting') return '重连 · 停止';
  if (state.phase === 'paused') return '暂停 · 停止';
  return `${state.active ? '停止' : '开始'}${name}`;
}

export function ObsOutputControls({ onError }: { onError: (message: string) => void }) {
  const { outputs, pending, execute } = useObsOutputs();
  const [confirmation, setConfirmation] = useState<ObsOutputCommand | null>(null);
  async function run(command: ObsOutputCommand) {
    setConfirmation(null);
    onError('');
    try {
      await execute(command);
    } catch (error) {
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
    !pending;
  return (
    <>
      <div className="workspace-obs-controls" aria-label="OBS 输出控制">
        {(['stream', 'record'] as const).map((kind) => {
          const state = outputs?.[kind];
          const busy = Boolean(
            pending || state?.pending || state?.phase === 'starting' || state?.phase === 'stopping',
          );
          return (
            <Button
              key={kind}
              disabled={!state || state.active === null || busy}
              aria-label={label(kind, state, pending)}
              loading={Boolean(
                (pending?.output === kind && pending) ||
                state?.pending ||
                state?.phase === 'starting' ||
                state?.phase === 'stopping',
              )}
              variant={state?.active ? 'secondary' : 'primary'}
              onClick={() => {
                if (!state) return;
                const command: ObsOutputCommand = {
                  output: kind,
                  action: state.active ? 'stop' : 'start',
                  expectedRevision: state.revision,
                };
                if (command.action === 'stop') setConfirmation(command);
                else void run(command);
              }}
            >
              {state?.active && state.phase === 'active' && !busy
                ? `${kind === 'stream' ? '直播中' : '录像中'} · 停止`
                : label(kind, state, pending)}
            </Button>
          );
        })}
      </div>
      <Dialog
        className="workspace-obs-confirmation"
        open={confirmation !== null}
        title={
          !canConfirm
            ? 'OBS 状态已变化，请重新核对'
            : confirmation?.output === 'stream'
              ? '停止 OBS 直播？'
              : '停止 OBS 录像？'
        }
        onClose={() => setConfirmation(null)}
      >
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
      </Dialog>
    </>
  );
}
