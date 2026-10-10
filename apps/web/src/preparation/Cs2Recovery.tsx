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
  async function run(action: () => Promise<unknown>, success = '恢复检查已完成。') {
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
  if (
    !status?.pending &&
    !status?.spectatorRecoveryPending &&
    !status?.demoCleanupPending &&
    !phase &&
    !feedback &&
    !status?.message
  )
    return null;
  const uncertain = status?.phase === 'uncertain';
  return (
    <StatusBanner
      tone={
        status?.spectatorRecoveryPending ||
        status?.demoCleanupPending ||
        status?.canPreserve ||
        (status?.pending &&
          !uncertain &&
          (!status.running || (Boolean(status.message) && !status.preserveSettings)))
          ? 'warning'
          : phase || uncertain || status?.running
            ? 'info'
            : 'success'
      }
    >
      <div className="cs2-recovery" aria-label="CS2 配置恢复">
        <strong>
          {phase
            ? cs2OperationLabel(phase)
            : status?.pending
              ? uncertain
                ? '正在等待 Steam 启动 CS2'
                : status.running
                  ? status.preserveSettings
                    ? 'CS2 正在运行，已保持原游戏设置'
                    : 'CS2 正在运行，原配置已备份'
                  : status.preserveSettings
                    ? '等待清理本次启动记录'
                    : 'CS2 原配置尚未恢复'
              : status?.spectatorRecoveryPending
                ? '观战原值尚未恢复'
                : status?.demoCleanupPending
                  ? '原设置已恢复，试播文件待清理'
                  : status?.canPreserve
                    ? '未应用游戏设置，原始配置已备份'
                    : '原设置已恢复'}
        </strong>
        {status?.canPreserve ? (
          <p>
            {status.message} 保持原设置继续时，不应用自动画质、帧率和游戏窗口布局，本机 HUD
            覆盖停用。
          </p>
        ) : null}
        {status?.pending ? (
          <p>
            {status.message ||
              (uncertain
                ? 'Steam 启动结果待确认，请先检查游戏和 Steam 启动请求。'
                : status.preserveSettings
                  ? '已保持原游戏设置；退出工作台会关闭本次游戏，保留游戏期间的新设置及原始备份。'
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
        {status?.spectatorRecoveryPending ? (
          <p>{status.message || '观战原值备份仍保留，帧率和画质恢复不受影响。'}</p>
        ) : null}
        {status?.demoCleanupPending ? (
          <p>
            {status.message ||
              '原画质和帧率已恢复；改动的试播文件及清理记录仍保留，可重试或打开备份目录检查。'}
          </p>
        ) : null}
        <div className="preparation-actions">
          {status?.canPreserve && production ? (
            <Button
              disabled={busy || Boolean(phase)}
              onClick={() =>
                void run(
                  () => productionAction('enter', production, true),
                  '已保持原游戏设置打开工作台。',
                )
              }
            >
              保持原游戏设置继续
            </Button>
          ) : null}
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
          {status?.demoCleanupPending ? (
            <Button
              disabled={busy || Boolean(phase) || Boolean(status.running)}
              onClick={() =>
                void run(() =>
                  desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: false }),
                )
              }
            >
              重试清理试播文件
            </Button>
          ) : null}
          {status?.spectatorRecoveryPending ? (
            <Button
              disabled={busy || Boolean(phase) || Boolean(status.running)}
              onClick={() =>
                void run(() =>
                  desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: false }),
                )
              }
            >
              重试恢复观战原值
            </Button>
          ) : null}
          {status?.pending ? (
            <Button
              disabled={busy || Boolean(phase) || !production || (uncertain && !cancelled)}
              onClick={() =>
                void run(
                  () =>
                    status.running && production
                      ? production.mode === 'preparation'
                        ? desktopInvoke('finish_managed_cs2')
                        : productionAction('finish', production)
                      : production?.mode === 'preparation'
                        ? desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: cancelled })
                        : productionAction('finish', production!),
                  status.preserveSettings
                    ? '本次启动已结束，游戏设置保持不变。'
                    : '恢复检查已完成。',
                )
              }
            >
              {status.preserveSettings
                ? status.running
                  ? '退出本次 CS2'
                  : '清理启动记录'
                : status.running
                  ? '退出 CS2 并恢复设置'
                  : '恢复配置备份'}
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
