import { useState } from 'react';
import { Button, Checkbox, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { productionAction, type Production } from './client';
import { cs2OperationLabel, useCs2Status } from './cs2-status';

/** Cross-window recovery reads the Host journal, never browser storage. */
export function Cs2Recovery({ production }: { production: Production | null }) {
  const { status, phase, error } = useCs2Status();
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [feedback, setFeedback] = useState('');
  async function run(action: () => Promise<unknown>, success = '原设置已恢复。') {
    if (busy || phase) return;
    setBusy(true);
    setFeedback('');
    try {
      await action();
      setFeedback(success);
      setCancelled(false);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : '恢复未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (!window.__TAURI_INTERNALS__) return null;
  if (error)
    return (
      <StatusBanner tone="danger">
        <p>{error} 备份仍保留。</p>
        <Button
          onClick={() =>
            void desktopInvoke('open_cs2_backup').catch((reason: unknown) =>
              setFeedback(reason instanceof Error ? reason.message : '备份目录无法打开。'),
            )
          }
        >
          打开备份目录
        </Button>
        {feedback ? <p>{feedback}</p> : null}
      </StatusBanner>
    );
  if (!status?.pending && !phase && !feedback && !status?.message) return null;
  const uncertain = status?.phase === 'uncertain';
  return (
    <StatusBanner
      tone={
        status?.pending && (!status.running || Boolean(status.message))
          ? 'warning'
          : phase || status?.running
            ? 'info'
            : 'success'
      }
    >
      <div className="cs2-recovery" aria-label="CS2 配置恢复">
        <strong>
          {phase
            ? cs2OperationLabel(phase)
            : status?.pending
              ? status.running
                ? 'CS2 正在运行，原配置已备份'
                : 'CS2 原配置尚未恢复'
              : '原设置已恢复'}
        </strong>
        {status?.pending ? (
          <p>
            {status.message ||
              (uncertain
                ? 'Steam 启动结果待确认，请先检查游戏和 Steam 启动请求。'
                : '退出工作台会关闭本次游戏并恢复配置；异常退出后可在这里重试。')}
          </p>
        ) : null}
        {uncertain ? (
          <Checkbox
            label="已取消 Steam 启动请求，并确认 CS2 已关闭"
            checked={cancelled}
            onChange={(event) => setCancelled(event.target.checked)}
          />
        ) : null}
        <div className="preparation-actions">
          {status?.running && production ? (
            <Button
              disabled={busy || Boolean(phase)}
              onClick={() =>
                void run(() => productionAction('enter', production), '工作台已打开。')
              }
            >
              打开直播工作台
            </Button>
          ) : null}
          {status?.pending ? (
            <Button
              disabled={busy || Boolean(phase) || !production || (uncertain && !cancelled)}
              onClick={() => {
                if (
                  status.running &&
                  !window.confirm('关闭受管理 CS2 并恢复配置？OBS 输出不会自动停止。')
                )
                  return;
                void run(() =>
                  status.running && production
                    ? production.mode === 'preparation'
                      ? desktopInvoke('finish_managed_cs2')
                      : productionAction('finish', production)
                    : production?.mode === 'preparation'
                      ? desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: cancelled })
                      : productionAction('finish', production!),
                );
              }}
            >
              {status.running ? '退出 CS2 并恢复设置' : '恢复配置备份'}
            </Button>
          ) : null}
          <Button
            disabled={busy || Boolean(phase)}
            onClick={() =>
              void desktopInvoke('open_cs2_backup').catch((reason: unknown) =>
                setFeedback(reason instanceof Error ? reason.message : '备份目录无法打开。'),
              )
            }
          >
            打开备份目录
          </Button>
        </div>
        {feedback ? <p role="status">{feedback}</p> : null}
      </div>
    </StatusBanner>
  );
}
