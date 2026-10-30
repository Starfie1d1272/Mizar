import { ReviewDialog, closeReviewWindow, isReviewWindow } from './ReviewDialog';
import { useEffect, useRef, useState } from 'react';
import { SILENCED_MATCH_KEY, SILENCE_CHANGED, setSilencedMatch } from './review-silence';
import { Button, StatusBanner } from '../ui';
import { command } from '../preparation/client';
import { RivalHubSyncControls } from '../operator/RivalHubSyncControls';
import { SupportExport } from '../debug/SupportExport';

export type SyncHealth = {
  status: 'inactive' | 'stopped' | 'other_device' | 'waiting' | 'healthy' | 'attention';
  reason: string | null;
  incidentId: string | null;
  deviceName: string | null;
};

export function syncHealthText(health?: SyncHealth): string {
  if (!health) return '网站接收待确认';
  if (health.status === 'healthy') return '网站正在接收本场数据';
  if (health.status === 'stopped') return '本机同步已停用';
  if (health.status === 'other_device') return `数据源归属：${health.deviceName ?? '其他设备'}`;
  if (health.status === 'inactive') return '等待正式比赛';
  if (health.status === 'waiting') return '等待网站接收本场数据';
  switch (health.reason) {
    case 'authorization_expired':
      return '网站授权已失效，请重新连接';
    case 'permission_denied':
      return '网站未授权本机同步，请核对权限';
    case 'context_conflict':
    case 'context_stale':
      return '比赛资料需要刷新并确认；等待新比赛数据。';
    case 'sequence_stale':
      return '网站记录的比赛进度与本机不一致，请核对后处理。';
    case 'generation_fence':
    case 'epoch_fence':
      return '网站尚未确认比赛连续性，请核对数据源与比赛进度。';
    case 'authority_changed':
      return '网站数据源归属已变化，请核对当前接管设备。';
    case 'idempotency_conflict':
    case 'invalid_schema':
      return '网站拒绝了本场数据，请导出诊断并核对网站状态。';
    case 'source_unavailable':
      return '本机尚未认领，本场未同步到网站';
    case 'map_start_pending':
      return '本场开局仍未获网站确认';
    case 'map_start_rejected':
    case 'http_400':
      return '网站未接受本场开局，请核对网站状态并导出诊断。';
    case 'network_failed':
    case 'timeout':
      return '网站同步连接未完成，请检查网络后重试';
    case 'input_unavailable':
      return '当前比赛数据不可用，请检查游戏连接与比赛资料';
    default:
      return '网站尚未确认接收本场数据';
  }
}

type AlertProps = {
  health: SyncHealth | undefined;
  matchId: string | undefined;
  isSource: boolean;
  onOpen: (path: string) => Promise<void>;
};

/** A website incident opens the centered review window; Program output is unchanged. */
export function SyncHealthAlert(props: AlertProps) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const health = props.health;
  const [silenced, setSilenced] = useState(() => {
    try {
      return Boolean(props.matchId && localStorage.getItem(SILENCED_MATCH_KEY) === props.matchId);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const update = (event?: StorageEvent) => {
      if (event && event.key !== null && event.key !== SILENCED_MATCH_KEY) return;
      setDismissed(null);
      try {
        setSilenced(
          Boolean(props.matchId && localStorage.getItem(SILENCED_MATCH_KEY) === props.matchId),
        );
      } catch {
        setSilenced(false);
      }
    };
    update();
    const localUpdate = (event: Event) => {
      setDismissed(null);
      setSilenced(
        Boolean(props.matchId && (event as CustomEvent<string | null>).detail === props.matchId),
      );
    };
    window.addEventListener('storage', update);
    window.addEventListener(SILENCE_CHANGED, localUpdate);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(SILENCE_CHANGED, localUpdate);
    };
  }, [props.matchId]);
  if (health?.status !== 'attention') return null;
  // Operation feedback and manual review belong only to this active incident.
  // Leaving attention unmounts them, including callbacks still awaiting a reply.
  return (
    <SyncHealthIncident
      key={health.incidentId}
      {...props}
      health={health}
      dismissed={silenced || dismissed === health.incidentId}
      onSilence={() => {
        if (!props.matchId) return;
        setSilencedMatch(props.matchId);
      }}
      onDismiss={() => setDismissed(health.incidentId)}
    />
  );
}

function SyncHealthIncident({
  health,
  isSource,
  onOpen,
  dismissed,
  onDismiss,
  onSilence,
  matchId,
}: AlertProps & {
  health: SyncHealth;
  dismissed: boolean;
  onDismiss: () => void;
  onSilence: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [feedback, setFeedback] = useState('');
  const reason = health?.reason;
  const text = syncHealthText(health);
  const run = async (operation: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFeedback('');
    try {
      await operation();
      setFeedback('操作已提交，等待网站接收本场新数据确认。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '操作未完成，请重试。');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const close = () => {
    onDismiss();
    setReviewing(false);
  };
  return (
    <>
      <StatusBanner tone="warning">
        <Button onClick={() => setReviewing(true)}>网站同步需处理</Button>
      </StatusBanner>
      <ReviewDialog
        kind="sync"
        open={isReviewWindow() || reviewing || Boolean(health.incidentId && !dismissed)}
        modal={false}
        className="workspace-live-roster-alert"
        title="本场网站同步需要处理"
        onClose={close}
      >
        <p role="status">{text}</p>
        {reason === 'authorization_expired' || reason === 'permission_denied' ? (
          <Button disabled={busy} onClick={() => void run(() => onOpen('/settings?tab=rivalhub'))}>
            重新连接网站
          </Button>
        ) : reason === 'input_unavailable' ? (
          <Button disabled={busy} onClick={() => void run(() => onOpen('/settings?tab=gsi'))}>
            检查游戏连接
          </Button>
        ) : reason === 'context_stale' ? (
          <Button
            disabled={busy}
            onClick={() => void run(() => command('/operator/rivalhub/refresh'))}
          >
            刷新比赛资料
          </Button>
        ) : [
            'sequence_stale',
            'generation_fence',
            'epoch_fence',
            'authority_changed',
            'idempotency_conflict',
            'invalid_schema',
            'map_start_rejected',
            'http_400',
          ].includes(reason ?? '') ? null : (
          <Button
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              void run(() =>
                command(
                  isSource ? '/operator/rivalhub/source/retry' : '/operator/rivalhub/source/claim',
                ),
              )
            }
          >
            立即重试同步
          </Button>
        )}
        {matchId ? (
          <Button
            onClick={() => {
              onSilence();
              close();
              void closeReviewWindow().catch((error) =>
                setFeedback(error instanceof Error ? error.message : '关闭核对窗口失败，请重试。'),
              );
            }}
          >
            本场不再弹出提示和警告
          </Button>
        ) : null}
        <RivalHubSyncControls />
        <details>
          <summary>详情与诊断导出</summary>
          <p>{text}</p>
          <p>重试只等待当前数据；网站补分不代表实时同步恢复。</p>
          <SupportExport />
        </details>
        {feedback ? <p role="status">{feedback}</p> : null}
      </ReviewDialog>
    </>
  );
}
