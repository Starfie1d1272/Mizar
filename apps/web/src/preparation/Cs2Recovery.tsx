import { browserErrorEvidence } from '../debug/control-journal';
import { ControlTask } from '../debug/control-task';
import { useRef, useState } from 'react';
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
export function Cs2Recovery({
  production,
  showManagedDetails = false,
}: {
  production: Production | null;
  showManagedDetails?: boolean;
}) {
  const { status, phase, error } = useCs2Status();
  const exit = useWorkspaceExitStatus();
  const [busy, setBusy] = useState(false);
  const operating = useRef(false);
  const [cancelled, setCancelled] = useState(false);
  const [feedback, setFeedback] = useState('');
  async function run(
    action: (task: ControlTask) => Promise<unknown>,
    success = '恢复检查已完成。',
    expected: 'restored' | 'spectator' | 'cleanup' | 'workspace' = 'restored',
  ) {
    if (operating.current || phase) return;
    operating.current = true;
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
      const workspaceExit =
        expected === 'restored'
          ? await desktopInvoke<WorkspaceExitStatus>('workspace_exit_status', undefined, task)
          : null;
      const idle = !after.busy && !after.running && !after.pending && after.phase !== 'uncertain';
      const restored =
        idle &&
        !after.spectatorRecoveryPending &&
        !after.demoCleanupPending &&
        workspaceExit !== null &&
        !workspaceExit.busy &&
        !workspaceExit.message &&
        !workspaceExit.windowMessage;
      const confirmed =
        expected === 'restored'
          ? restored
          : expected === 'spectator'
            ? idle && !after.spectatorRecoveryPending
            : expected === 'cleanup'
              ? idle && !after.demoCleanupPending
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
      operating.current = false;
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
            {exit.busy ? '正在结束制作' : '结束制作需要处理'} · {workspaceExitLabel(exit.stage)}
          </strong>
          <p role="status">
            {exit.busy ? '正在安全收尾，请等待结果。可以打开诊断查看进度。' : exit.message}
          </p>
          {!exit.busy ? (
            <p>
              {uncertain
                ? '先取消启动请求并确认 CS2 与 MulNX 启动器已关闭，再恢复配置备份。'
                : '按上面的原因处理后重试；再次失败时，在运行诊断中导出诊断包反馈。'}
            </p>
          ) : null}
          {uncertain && !exit.busy ? (
            <Checkbox
              label="已取消启动请求，并确认 CS2 与 MulNX 启动器已关闭"
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
              {exit.busy
                ? '正在结束…'
                : uncertain
                  ? '恢复配置并重试退出'
                  : exit.stage === 'restoration' && status && !status.running
                    ? '重试恢复设置'
                    : '重试结束制作'}
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
        <p>
          如果发生在启动过程中，请先取消启动请求并关闭 CS2 与 MulNX 启动器。
          状态重新确认后，按页面提示恢复设置；恢复完成后可在
          <a href="/settings?tab=gsi">游戏设置</a>选择「标准启动」并保存，再打开工作台。
        </p>
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
  const preserveAction =
    status?.canPreserve && production ? (
      <details>
        <summary>保留画质与帧率</summary>
        <p>保留画质与帧率，仍将游戏调整为工作台窗口布局。本机 HUD 跟随游戏窗口。</p>
        <Button
          disabled={busy || Boolean(phase)}
          onClick={() =>
            void run(
              (task) => productionAction('enter', production, true, task),
              '已保留画质与帧率打开工作台。',
              'workspace',
            )
          }
        >
          保留画质与帧率打开工作台
        </Button>
      </details>
    ) : null;
  if (
    !status?.pending &&
    !status?.spectatorRecoveryPending &&
    !status?.demoCleanupPending &&
    !phase &&
    !feedback &&
    !status?.message &&
    !exit?.windowMessage
  )
    return preserveAction;
  const uncertain = status?.phase === 'uncertain';
  const endsProduction = Boolean(production && production.mode !== 'preparation');
  const managedNormally = Boolean(
    status?.pending &&
    status.running &&
    !uncertain &&
    !status.message &&
    !status.spectatorRecoveryPending &&
    !status.demoCleanupPending &&
    !exit?.windowMessage &&
    !phase &&
    !busy &&
    !feedback,
  );
  if (managedNormally && !showManagedDetails) return null;
  const content = (
    <div className="cs2-recovery" aria-label="CS2 配置恢复">
      <strong>
        {phase
          ? cs2OperationLabel(phase)
          : exit?.windowMessage
            ? '窗口控制需要处理'
            : status?.pending
              ? uncertain
                ? '游戏启动结果待确认'
                : status.running
                  ? status.preserveSettings
                    ? 'CS2 正在运行，已保留画质与帧率'
                    : 'CS2 正在运行，原配置已备份'
                  : status.preserveSettings
                    ? '窗口设置尚未恢复'
                    : 'CS2 原配置尚未恢复'
              : status?.spectatorRecoveryPending
                ? '观战原值尚未恢复'
                : status?.demoCleanupPending
                  ? '原设置已恢复，试播文件待清理'
                  : status?.canPreserve
                    ? '游戏启动设置'
                    : '原设置已恢复'}
      </strong>
      {exit?.windowMessage ? <p role="alert">{exit.windowMessage}</p> : null}
      {uncertain ? (
        <p>游戏启动结果尚未确认。请先取消启动请求，并关闭 CS2 与 MulNX 启动器，再确认恢复。</p>
      ) : null}
      {uncertain ? (
        <Checkbox
          label="已取消启动请求，并确认 CS2 与 MulNX 启动器已关闭"
          checked={cancelled}
          onChange={(event) => setCancelled(event.target.checked)}
        />
      ) : null}
      {status?.spectatorRecoveryPending ? (
        <p>{status.spectatorWarning || '只恢复 Mizar 的观战设置，不改动原游戏画面设置。'}</p>
      ) : null}
      {status?.demoCleanupPending ? (
        <p>原画质和帧率已恢复；试播文件仍待清理，可重试或打开备份目录检查。</p>
      ) : null}
      {status?.pending ? (
        <p>
          {status.running || endsProduction
            ? `此操作会${endsProduction ? '结束本次制作并' : ''}关闭本次 CS2，再恢复${status.preserveSettings ? '窗口设置' : '原设置'}。`
            : `恢复${status.preserveSettings ? '窗口设置' : '原设置'}不会启动或关闭游戏。`}
          {status.preserveSettings ? '画质与帧率保持不变，人工修改和原始备份仍保留。' : ''}
        </p>
      ) : null}
      {uncertain ? (
        <p>
          恢复完成后可在<a href="/settings?tab=gsi">游戏设置</a>
          选择「标准启动」并保存，再打开工作台。
        </p>
      ) : null}
      {status?.message ? (
        <details>
          <summary>上次操作详情</summary>
          <p>{status.message}</p>
        </details>
      ) : null}
      {preserveAction}
      <div className="preparation-actions">
        {status?.mulnxLaunchResumable && production ? (
          <Button
            disabled={busy || Boolean(phase)}
            onClick={() =>
              void run(
                (task) =>
                  productionAction('enter', production, Boolean(status.preserveSettings), task),
                '工作台已打开。',
                'workspace',
              )
            }
          >
            重试进入工作台
          </Button>
        ) : null}
        {status?.running && !status.mulnxLaunchResumable && production ? (
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
            返回工作台
          </Button>
        ) : null}
        {status?.demoCleanupPending ? (
          <Button
            disabled={busy || Boolean(phase) || Boolean(status.running)}
            onClick={() =>
              void run(
                (task) =>
                  desktopInvoke('restore_cs2_backup', { confirmSteamCancelled: false }, task),
                '试播文件已清理。',
                'cleanup',
              )
            }
          >
            重试清理试播文件
          </Button>
        ) : null}
        {status?.spectatorRecoveryPending ? (
          <Button
            disabled={
              busy || Boolean(phase) || Boolean(status.running) || (uncertain && !cancelled)
            }
            onClick={() =>
              void run(
                (task) =>
                  desktopInvoke(
                    'restore_cs2_backup',
                    { confirmSteamCancelled: uncertain && cancelled },
                    task,
                  ),
                '观战原值已恢复。',
                'spectator',
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
                      : productionAction('finish', production, false, task, undefined, {
                          confirmSteamCancelled: uncertain && cancelled,
                        })
                    : production?.mode === 'preparation'
                      ? desktopInvoke(
                          'restore_cs2_backup',
                          { confirmSteamCancelled: cancelled },
                          task,
                        )
                      : productionAction('finish', production!, false, task, undefined, {
                          confirmSteamCancelled: uncertain && cancelled,
                        }),
                status.preserveSettings
                  ? '窗口设置恢复检查已完成，画质与帧率及人工修改保持不变。'
                  : '恢复检查已完成。',
              )
            }
          >
            {status.preserveSettings
              ? status.running
                ? '退出 CS2 并恢复窗口设置'
                : endsProduction
                  ? '结束制作并恢复窗口设置'
                  : '恢复窗口设置'
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
  );
  if (managedNormally)
    return (
      <details>
        <summary>本次游戏设置与备份</summary>
        {content}
      </details>
    );
  return (
    <StatusBanner
      tone={
        exit?.windowMessage ||
        uncertain ||
        status?.message ||
        status?.spectatorRecoveryPending ||
        status?.demoCleanupPending ||
        (status?.pending && !status.running)
          ? 'warning'
          : phase || status?.running
            ? 'info'
            : 'success'
      }
    >
      {content}
    </StatusBanner>
  );
}
