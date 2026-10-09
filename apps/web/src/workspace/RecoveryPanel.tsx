import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { Cs2Recovery } from '../preparation/Cs2Recovery';
import { useLocalRead, openTool, type Production } from '../preparation/client';
import { desktopInvoke } from './client';
import { obsCommand, useObsStatus } from './obs-client';
import { RivalHubLiveSourcePanel } from './RivalHubLiveSourcePanel';

/** Local recovery occupies the radar area; native game and scene controls stay available. */
export function RecoveryPanel({ onClose }: { onClose: () => void }) {
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
      <Cs2Recovery production={production} />
      <RivalHubLiveSourcePanel action={action} onMessage={setMessage} />
      {message ? <StatusBanner tone="warning">{message}</StatusBanner> : null}
    </section>
  );
}
