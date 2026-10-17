import { browserErrorEvidence } from '../debug/control-journal';
import { ControlTask } from '../debug/control-task';
import { useState } from 'react';
import { Button, Checkbox, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { openTool, productionAction, type Production } from './client';
import {
  cs2OperationLabel,
  useCs2Status,
  useWorkspaceExitStatus,
  workspaceExitLabel,
  type Cs2ConfigStatus,
  type WorkspaceExitStatus,
} from './cs2-status';

/** Cross-window recovery reads the Host journal, never browser storage. */
export function Cs2Recovery({ production }: { production: Production | null }) {
  const { status, phase, error } = useCs2Status();
  const exit = useWorkspaceExitStatus();
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [feedback, setFeedback] = useState('');
  async function run(
    action: (task: ControlTask) => Promise<unknown>,
    success = '恢复检查已完成。',
    expected: 'restored' | 'workspace' = 'restored',
  ) {
    if (busy || phase) return;
    setBusy(true);
    setFeedback('');
    const task = new ControlTask('recovery_action', 'user', {
      status,
      workspaceExit: exit,
      expected,
    });
    let acknowledged = false;
    try {
      const outcome = await action(task);
      acknowledged = true;
      const after = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status', undefined, task);
      const workspaceExit = await desktopInvoke<WorkspaceExitStatus>(
        'workspace_exit_status',
        undefined,
        task,
      );
      const restored =
        !after.busy &&
        !after.running &&
        !after.pending &&
        !after.spectatorRecoveryPending &&
        !after.demoCleanupPending &&
        !after.canPreserve &&
        after.phase !== 'uncertain' &&
        !workspaceExit.busy &&
        !workspaceExit.message &&
        !workspaceExit.windowMessage;
      const confirmed =
        expected === 'restored'
          ? restored
          : outcome === 'confirmed' && after.running === true && !after.busy;
      task.finish(
        confirmed
          ? 'confirmed'
          : outcome === 'blocked' || outcome === 'cancelled'
            ? outcome
            : 'unconfirmed',
        {
          after,
          workspaceExit,
          confirmation: confirmed ? 'host_command_and_status_readback' : 'recovery_still_pending',
        },
      );
      setFeedback(confirmed ? success : '处理结果仍待确认，请查看当前状态；备份和处理记录仍保留。');
      setCancelled(false);
    } catch (reason) {
      if (acknowledged)
        task.finish('unconfirmed', {
          reason: 'host_readback_failed',
          error: browserErrorEvidence(reason),
        });
      else task.fail(reason);
      setFeedback(
        acknowledged
          ? '处理结果尚未确认，请检查当前状态后重试。'
          : reason instanceof Error
            ? reason.message
            : '恢复未完成，请重试。',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!window.__TAURI_INTERNALS__) return null;
  if (exit?.busy || exit?.message) {
    const uncertain = status?.phase === 'uncertain';
    return (
      <StatusBanner tone={exit.busy ? 'info' : 'warning'}>
        <div className="cs2-recovery" aria-label="工作台退出结果">
          <strong>
            {exit.busy ? '正在退出工作台' : '退出工作台需要处理'} · {workspaceExitLabel(exit.stage)}
          </strong>
          <p role="status">
            {exit.busy ? '正在安全收尾，请等待结果。可以打开诊断查看进度。' : exit.message}
          </p>
          {!exit.busy ? (
            <p>
              {uncertain
                ? '先取消 Steam 启动请求并确认游戏已关闭，再恢复配置备份。'
                : '按上面的原因处理后重试；再次失败时，在运行诊断中导出诊断包反馈。'}
            </p>
          ) : null}
          {uncertain && !exit.busy ? (
            <Checkbox
              label="已取消 Steam 启动请求，并确认 CS2 已关闭"
              checked={cancelled}
              onChange={(event) => setCancelled(event.target.checked)}
            />
          ) : null}
          <div className="preparation-actions">
            <Button
              disabled={busy || exit.busy || Boolean(phase) || (uncertain && !cancelled)}
              onClick={() =>
                void run(async (task) => {
                  await desktopInvoke(
                    'finish_workspace',
                    uncertain ? { confirmSteamCancelled: cancelled } : undefined,
                    task,
                  );
                }, '')
              }
            >
              {exit.busy ? '正在退出…' : uncertain ? '恢复配置并重试退出' : '重试退出工作台'}
            </Button>
            <Button
              onClick={() =>
                void openTool('diagnostics').catch((reason: unknown) =>
                  setFeedback(reason instanceof Error ? reason.message : '诊断窗口无法打开。'),
                )
              }
            >
              运行诊断
            </Button>
          </div>
          {feedback && feedback !== exit.message ? <p role="alert">{feedback}</p> : null}
        </div>
      </StatusBanner>
    );
  }
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
    !status?.borrowed &&
    !status?.pending &&
    !status?.spectatorRecoveryPending &&
    !status?.demoCleanupPending &&
    !phase &&
    !feedback &&
    !status?.message &&
    !exit?.windowMessage
  )
    return null;
  const uncertain = status?.phase === 'uncertain';
  const endsProduction = Boolean(production && production.mode !== 'preparation');
  return (
    <StatusBanner
      tone={
        exit?.windowMessage ||
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
            : exit?.windowMessage
              ? '窗口控制需要处理'
              : status?.borrowed
                ? status.running
                  ? '已借用外部 CS2'
                  : '借用实例已失效'
                : status?.externalDetached
                  ? '游戏借用已结束'
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
        {exit?.windowMessage ? <p role="alert">{exit.windowMessage}</p> : null}
        {status?.canPreserve ? (
          <p>
            {status.message} 保持原设置继续时，不应用自动画质、帧率和游戏窗口布局，本机 HUD
            覆盖停用。
          </p>
        ) : null}
        {status?.externalDetached ? <p>{status.message}</p> : null}
        {status?.borrowed ? (
          <p>退出工作台只解除借用，外部游戏由原启动方退出；不会恢复或覆盖其设置。</p>
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
        {status?.pending ? (
          <p>
            {status.running
              ? status.preserveSettings
                ? '退出按钮会关闭本次 CS2，保留游戏设置并清理启动记录。'
                : '退出按钮会关闭本次 CS2，再恢复配置备份。'
              : endsProduction
                ? status.preserveSettings
                  ? '此操作会先结束本次制作，并关闭本次 CS2；保留游戏设置并清理记录。'
                  : '此操作会先结束本次制作，并关闭本次 CS2，再恢复配置备份。'
                : status.preserveSettings
                  ? '清理启动记录不会启动或关闭游戏，也不会替换当前游戏设置。'
                  : '恢复配置备份只恢复设置，不会启动或关闭游戏。'}
          </p>
        ) : null}
        <div className="preparation-actions">
          {status?.borrowed && production ? (
            <Button
              disabled={busy || Boolean(phase)}
              onClick={() =>
                void run(
                  (task) => productionAction('finish', production, false, task),
                  '已解除借用，外部游戏保持不变。',
                )
              }
            >
              结束制作并解除借用
            </Button>
          ) : null}
          {status?.canPreserve && production ? (
            <Button
              disabled={busy || Boolean(phase)}
              onClick={() =>
                void run(
                  (task) => productionAction('enter', production, true, task),
                  '已保持原游戏设置打开工作台。',
                  'workspace',
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
                void run(
                  (task) => productionAction('enter', production, false, task),
                  '工作台已打开。',
                  'workspace',
                )
              }
            >
              打开直播工作台
            </Button>
          ) : null}
          {status?.demoCleanupPending ? (
            <Button
              disabled={busy || Boolean(phase) || Boolean(status.running)}
              onClick={() =>
                void run((task) =>
                  desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: false }, task),
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
                void run((task) =>
                  desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: false }, task),
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
                  (task) =>
                    status.running && production
                      ? production.mode === 'preparation'
                        ? desktopInvoke('finish_managed_cs2', undefined, task)
                        : productionAction('finish', production, false, task)
                      : production?.mode === 'preparation'
                        ? desktopInvoke(
                            'restore_cs2_backup',
                            { confirmSteamCancelled: cancelled },
                            task,
                          )
                        : productionAction('finish', production!, false, task),
                  status.preserveSettings
                    ? '本次启动已结束，游戏设置保持不变。'
                    : '恢复检查已完成。',
                )
              }
            >
              {status.preserveSettings
                ? status.running
                  ? '退出本次 CS2'
                  : endsProduction
                    ? '结束制作并清理记录'
                    : '清理启动记录'
                : status.running
                  ? '退出 CS2 并恢复设置'
                  : endsProduction
                    ? '结束制作并恢复设置'
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
