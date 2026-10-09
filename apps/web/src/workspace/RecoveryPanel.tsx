import { useState } from 'react';
import type { OperatorPayload } from '@mizar/protocol/operator';
import { workspaceIssues } from './model';
import { Button, StatusBanner } from '../ui';
import { Cs2Recovery } from '../preparation/Cs2Recovery';
import { useLocalRead, openTool, type Production } from '../preparation/client';
import { desktopInvoke } from './client';
import { obsCommand, useObsStatus } from './obs-client';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';

/** Local recovery occupies the radar area; native game and scene controls stay available. */
export function RecoveryPanel({
  onClose,
  operator = null,
}: {
  onClose: () => void;
  operator?: OperatorPayload | null;
}) {
  const obs = useObsStatus();
  const production = useLocalRead<Production>('/local/v1/production');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await run();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '恢复未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-recovery" aria-label="原位恢复面板">
      <header className="workspace-section-heading">
        <strong>现场恢复</strong>
        <Button onClick={onClose}>返回雷达</Button>
      </header>
      <p>游戏与正式切场控制继续可用。先检查，再执行必要的恢复。</p>
      <strong>
        {operator?.matchContext.summary
          ? `${operator.matchContext.summary.entryAName} vs ${operator.matchContext.summary.entryBName}`
          : '比赛与实时数据待确认'}
      </strong>
      {workspaceIssues(operator).map((issue) => (
        <p key={issue} role="status">
          {issue}
        </p>
      ))}
      {operator?.runtime.telemetryFreshness !== 'fresh' ? (
        <p>没有 GSI 不代表游戏已退出。先检查 CS2 观战与 GOTV 连接；需要配置检查时再打开设置。</p>
      ) : null}
      <Button
        onClick={() =>
          void action(async () => {
            if (window.__TAURI_INTERNALS__)
              await desktopInvoke('open_main', { path: '/settings?tab=gsi' });
            else window.open('/settings?tab=gsi', 'mizar-preparation');
          })
        }
      >
        检查 CS2 / GSI
      </Button>
      {operator?.identity.state === 'mismatch' ||
      operator?.seriesProgress?.bindingState === 'needs_operator' ? (
        <Button
          onClick={() =>
            void action(async () => {
              if (window.__TAURI_INTERNALS__)
                await desktopInvoke('open_main', { path: '/matches?tab=roster' });
              else window.open('/?tab=roster', 'mizar-preparation');
            })
          }
        >
          核对名单与地图绑定
        </Button>
      ) : null}
      <p>
        制作 · {production?.mode ?? '无法确认'} · OBS ·{' '}
        {obs?.connection === 'connected' ? '已连接' : '无法确认连接'}
      </p>
      <p>
        推流 / 录制 ·{' '}
        {obs?.connection === 'connected'
          ? `${obs.streaming ? '推流中' : '未推流'} / ${obs.recording ? '录制中' : '未录制'}`
          : '无法确认，不能推断已停止'}
      </p>
      <Button disabled={busy} onClick={() => void action(() => obsCommand('check'))}>
        重新检查 / 重连 OBS
      </Button>
      <Button
        disabled={busy || !window.__TAURI_INTERNALS__}
        onClick={() => void action(() => desktopInvoke('restore_layout'))}
      >
        恢复现有窗口布局
      </Button>
      <Button disabled={busy} onClick={() => void action(() => openTool('diagnostics'))}>
        运行诊断 / 导出证据
      </Button>
      <p>
        重连后核对当前节目、实际画面与声音，再决定是否点击底栏「恢复自动」；重连本身不会交回人工控制。
      </p>
      <Cs2Recovery production={production} />
      <RivalHubLiveSourcePanel action={action} onMessage={setMessage} />
      {message ? <StatusBanner tone="warning">{message}</StatusBanner> : null}
    </section>
  );
}
